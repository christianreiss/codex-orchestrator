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
use App\Services\AuthService;
use App\Support\InstallerScriptBuilder;
use App\Support\SeedAuthScriptBuilder;

class InstallController
{
    private InstallTokenRepository $installTokenRepository;
    private HostRepository $hostRepository;
    private LogRepository $logRepository;
    private AuthService $service;
    private AuthSeedTokenRepository $seedTokenRepository;

    public function __construct(
        InstallTokenRepository $installTokenRepository,
        HostRepository $hostRepository,
        LogRepository $logRepository,
        AuthService $service,
        AuthSeedTokenRepository $seedTokenRepository
    ) {
        $this->installTokenRepository = $installTokenRepository;
        $this->hostRepository = $hostRepository;
        $this->logRepository = $logRepository;
        $this->service = $service;
        $this->seedTokenRepository = $seedTokenRepository;
    }

    /** GET /install/{token} — consume an install token and emit the installer script. */
    public function install(string $tokenValue): void
    {
        $tokenValue = (string) $tokenValue;
        $tokenRow = $this->installTokenRepository->findByToken($tokenValue);
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
        $host = $this->hostRepository->findById($hostId);
        if (!$host) {
            installerError('Installer host missing', 404);
        }

        // Some legacy/insecure-host paths ended up writing install_tokens with an empty api_key
        // (hash of ""), which breaks the installer emission. Recover by decrypting the host's
        // encrypted API key when the token payload is blank.
        if (empty($tokenRow['api_key'] ?? '')) {
            $hostPlain = $this->hostRepository->decryptApiKey($host['api_key_enc'] ?? null);
            if ($hostPlain) {
                $tokenRow['api_key'] = $hostPlain;
            }
        }

        $baseUrl = resolveInstallerBaseUrl($tokenRow);
        if ($baseUrl === '') {
            installerError('Installer base URL invalid', 500, $tokenRow['expires_at'] ?? null);
        }

        $this->installTokenRepository->markUsed((int) $tokenRow['id']);
        $this->logRepository->log($hostId, 'install.token.consume', [
            'token' => substr((string) $tokenRow['token'], 0, 8) . "\u{2026}",
        ]);

        try {
            $body = InstallerScriptBuilder::build($host, $tokenRow, $baseUrl, $this->service->versionSummary());
        } catch (\InvalidArgumentException $exception) {
            installerError($exception->getMessage(), 500, $tokenRow['expires_at'] ?? null);
        }
        emitInstaller($body, 200, $tokenRow['expires_at'] ?? null);
    }

    /** GET /seed/auth/{token} — emit the seed-auth bootstrap script. */
    public function seedAuthScript(string $tokenValue): void
    {
        $tokenRow = $this->seedTokenRepository->findByToken($tokenValue);
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

        try {
            $body = SeedAuthScriptBuilder::build($baseUrl, (string) $tokenRow['token']);
        } catch (\InvalidArgumentException $exception) {
            seedAuthError($exception->getMessage(), 500, $tokenRow['expires_at'] ?? null);
        }

        emitSeedScript($body, 200, $tokenRow['expires_at'] ?? null);
    }

    /** POST /seed/auth/{token} — accept an auth.json payload via the seed token. */
    public function seedAuthStore(string $tokenValue): void
    {
        $tokenRow = $this->seedTokenRepository->findByToken($tokenValue);
        if (!$tokenRow) {
            Response::json([
                'status' => 'error',
                'message' => 'Seed token not found',
            ], 404);
        }
        if ($tokenRow['used_at'] ?? null) {
            Response::json([
                'status' => 'error',
                'message' => 'Seed token already used',
            ], 410);
        }
        if (seedAuthTokenExpired($tokenRow)) {
            Response::json([
                'status' => 'error',
                'message' => 'Seed token expired',
            ], 410);
        }

        $raw = file_get_contents('php://input');
        $decoded = null;
        if (is_string($raw) && trim($raw) !== '') {
            $decoded = json_decode($raw, true);
        }

        if (!is_array($decoded)) {
            $this->seedTokenRepository->markUsed((int) $tokenRow['id']);
            $this->logRepository->log(null, 'auth.seed.consume', [
                'token' => substr((string) $tokenRow['token'], 0, 8) . "\u{2026}",
                'status' => 'invalid_json',
            ]);
            Response::json([
                'status' => 'error',
                'message' => 'auth.json payload must be valid JSON',
            ], 422);
        }

        $authPayload = $decoded['auth'] ?? $decoded;
        if (!is_array($authPayload)) {
            $this->seedTokenRepository->markUsed((int) $tokenRow['id']);
            $this->logRepository->log(null, 'auth.seed.consume', [
                'token' => substr((string) $tokenRow['token'], 0, 8) . "\u{2026}",
                'status' => 'invalid_payload',
            ]);
            Response::json([
                'status' => 'error',
                'message' => 'auth.json payload must be an object',
            ], 422);
        }

        $this->seedTokenRepository->markUsed((int) $tokenRow['id']);
        $this->logRepository->log(null, 'auth.seed.consume', [
            'token' => substr((string) $tokenRow['token'], 0, 8) . "\u{2026}",
        ]);

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
                ['command' => 'store', 'auth' => $authPayload],
                $host,
                'seed-upload',
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
            Response::json([
                'status' => 'error',
                'message' => $exception->getMessage(),
            ], $exception->getStatusCode());
        }

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }
}
