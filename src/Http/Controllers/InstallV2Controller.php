<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Http\Response;
use App\Repositories\AuthSeedTokenRepository;
use App\Repositories\HostRepository;
use App\Repositories\InstallTokenRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\Wrapper\V2\InstallerScriptBuilderV2;
use App\Services\Wrapper\V2\SeedAuthScriptBuilderV2;
use App\Support\Engine;

/**
 * Install/Seed v2 controller — emits the compact v2 installer and seed-auth
 * scripts. The legacy /install/{token} and /seed/auth/{token} routes alias
 * here once the cutover commit lands.
 */
class InstallV2Controller
{
    public function __construct(
        private readonly InstallTokenRepository $installTokens,
        private readonly HostRepository $hosts,
        private readonly LogRepository $logs,
        private readonly AuthService $service,
        private readonly AuthSeedTokenRepository $seedTokens,
        private readonly ?VersionRepository $versions = null,
    ) {
    }

    public function install(string $tokenValue): void
    {
        $tokenRow = $this->installTokens->findByToken((string) $tokenValue);
        if (!$tokenRow) {
            installerError('Installer not found', 404);
        }
        if ($tokenRow['used_at'] ?? null) {
            installerError('Installer already used', 410);
        }
        if (installerTokenExpired($tokenRow)) {
            installerError('Installer expired', 410);
        }

        $hostId = (int) ($tokenRow['host_id'] ?? 0);
        $host = $this->hosts->findById($hostId);
        if (!$host) {
            installerError('Installer host missing', 404);
        }

        if (empty($tokenRow['api_key'] ?? '')) {
            $plain = $this->hosts->decryptApiKey($host['api_key_enc'] ?? null);
            if ($plain) {
                $tokenRow['api_key'] = $plain;
            }
        }

        $baseUrl = resolveInstallerBaseUrl($tokenRow);
        if ($baseUrl === '') {
            installerError('Installer base URL invalid', 500, $tokenRow['expires_at'] ?? null);
        }
        $engine = $this->resolveEngine($tokenRow);

        $this->installTokens->markUsed((int) $tokenRow['id']);
        $this->logs->log($hostId, 'install.v2.token.consume', [
            'token'  => substr((string) ($tokenRow['token'] ?? ''), 0, 8) . "\u{2026}",
            'engine' => $engine,
        ]);

        try {
            $body = InstallerScriptBuilderV2::build($host, $tokenRow, $baseUrl, $engine);
        } catch (\InvalidArgumentException $exception) {
            installerError($exception->getMessage(), 500, $tokenRow['expires_at'] ?? null);
        }
        emitInstaller($body, 200, $tokenRow['expires_at'] ?? null);
    }

    public function seedAuthScript(string $tokenValue): void
    {
        $tokenRow = $this->seedTokens->findByToken((string) $tokenValue);
        if (!$tokenRow) {
            seedAuthError('Seed token not found', 404);
        }
        if ($tokenRow['used_at'] ?? null) {
            seedAuthError('Seed token already used', 410);
        }
        if (seedAuthTokenExpired($tokenRow)) {
            seedAuthError('Seed token expired', 410);
        }

        $baseUrl = resolveSeedBaseUrl($tokenRow);
        if ($baseUrl === '') {
            seedAuthError('Seed base URL invalid', 500, $tokenRow['expires_at'] ?? null);
        }
        $engine = $this->resolveEngine($tokenRow);
        try {
            $body = SeedAuthScriptBuilderV2::build($baseUrl, (string) $tokenRow['token'], $engine);
        } catch (\InvalidArgumentException $exception) {
            seedAuthError($exception->getMessage(), 500, $tokenRow['expires_at'] ?? null);
        }
        emitSeedScript($body, 200, $tokenRow['expires_at'] ?? null);
    }

    public function seedAuthStore(string $tokenValue): void
    {
        $tokenRow = $this->seedTokens->findByToken((string) $tokenValue);
        if (!$tokenRow) {
            Response::json(['status' => 'error', 'message' => 'Seed token not found'], 404);
        }
        if ($tokenRow['used_at'] ?? null) {
            Response::json(['status' => 'error', 'message' => 'Seed token already used'], 410);
        }
        if (seedAuthTokenExpired($tokenRow)) {
            Response::json(['status' => 'error', 'message' => 'Seed token expired'], 410);
        }

        $raw = file_get_contents('php://input');
        $decoded = null;
        if (is_string($raw) && trim($raw) !== '') {
            $decoded = json_decode($raw, true);
        }
        if (!is_array($decoded)) {
            $this->seedTokens->markUsed((int) $tokenRow['id']);
            Response::json(['status' => 'error', 'message' => 'auth payload must be valid JSON'], 422);
        }
        $authPayload = $decoded['auth'] ?? $decoded;
        if (!is_array($authPayload)) {
            $this->seedTokens->markUsed((int) $tokenRow['id']);
            Response::json(['status' => 'error', 'message' => 'auth payload must be an object'], 422);
        }

        $engine = $this->resolveEngine($tokenRow);
        $host = [
            'id' => 0,
            'fqdn' => '[seed]',
            'status' => 'active',
            'api_calls' => 0,
            'allow_roaming_ips' => true,
            'secure' => true,
        ];
        try {
            $result = $this->service->handleAuth(
                ['command' => 'store', 'auth' => $authPayload, 'engine' => $engine],
                $host,
                'seed-upload-v2',
                null,
                null,
                false
            );
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        } catch (HttpException $exception) {
            Response::json(['status' => 'error', 'message' => $exception->getMessage()], $exception->getStatusCode());
        }

        $this->seedTokens->markUsed((int) $tokenRow['id']);
        $this->logs->log(null, 'auth.seed.v2.consume', [
            'token'  => substr((string) ($tokenRow['token'] ?? ''), 0, 8) . "\u{2026}",
            'engine' => $engine,
            'status' => $result['status'] ?? null,
        ]);

        if ($this->versions !== null) {
            try {
                $this->versions->set('preflight_force_run', '1');
            } catch (\Throwable) {
                // best-effort
            }
        }
        Response::json(['status' => 'ok', 'data' => $result]);
    }

    /** @param array<string,mixed> $tokenRow */
    private function resolveEngine(array $tokenRow): string
    {
        $engine = $tokenRow['engine'] ?? null;
        if (is_string($engine) && Engine::isValid($engine)) {
            return $engine;
        }
        return Engine::CODEX;
    }
}
