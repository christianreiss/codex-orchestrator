<?php

declare(strict_types=1);

namespace App\Services\Wrapper\V2;

use App\Repositories\HostRepository;
use App\Repositories\VersionRepository;
use App\Support\Engine;
use PDO;
use RuntimeException;

/**
 * Renders the per-host wrapper config JSON that replaces the legacy bash
 * placeholder soup. Output matches wrappers/schemas/host-config-v1.json.
 *
 * Result is written to the BakeCache and signed by ConfigSigner. Any host
 * field that affects the rendered blob bumps hosts.config_version so the
 * binary picks up the change on its next run.
 */
final class ConfigBaker
{
    public const SCHEMA_VERSION = 1;

    public function __construct(
        private readonly HostRepository $hosts,
        private readonly VersionRepository $versions,
        private readonly ConfigSigner $signer,
        private readonly BinaryRegistry $binaries,
        private readonly BakeCache $cache,
        private readonly PDO $pdo,
        private readonly string $installationId,
    ) {
    }

    /**
     * Bake the per-host config for $engine. Bumps hosts.config_version and
     * writes the resulting JSON/signature/meta into the cache.
     *
     * @return array{config_version:int,etag:string,size_bytes:int,baked_at:string}
     */
    public function bakeForHost(int $hostId, string $engine, string $publicBaseUrl): array
    {
        $engine = Engine::isValid($engine) ? $engine : Engine::CODEX;
        $host = $this->hosts->findById($hostId);
        if (!$host) {
            throw new RuntimeException("Host $hostId not found");
        }

        $apiKey = is_string($host['api_key'] ?? null) && $host['api_key'] !== ''
            ? (string) $host['api_key']
            : (string) ($this->hosts->decryptApiKey($host['api_key_enc'] ?? null) ?? '');
        if ($apiKey === '') {
            throw new RuntimeException("Host $hostId has no usable API key");
        }

        $configVersion = $this->bumpConfigVersion($hostId);
        $bakedAt = gmdate(DATE_ATOM);

        $payload = [
            'schema_version' => self::SCHEMA_VERSION,
            'engine'         => $engine,
            'issued_at'      => $bakedAt,
            'expires_at'     => null,
            'orchestrator'   => $this->orchestratorBlock($publicBaseUrl, $apiKey, (bool) ($host['curl_insecure'] ?? false)),
            'host'           => [
                'id'     => (int) $host['id'],
                'fqdn'   => (string) $host['fqdn'],
                'secure' => (bool) ($host['secure'] ?? true),
                'browseros_mcp_enabled' => (bool) ($host['browseros_mcp_enabled'] ?? false),
            ],
            'engine_options' => $this->engineOptions($host, $engine),
            'wrapper'        => $this->wrapperBlock($engine, $publicBaseUrl),
            'config_version' => $configVersion,
        ];

        $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) ?: '';
        if ($json === '') {
            throw new RuntimeException("Failed to encode host config payload");
        }
        $signature = $this->signer->sign($json);
        $etag = hash('sha256', $json);

        $meta = $this->cache->put($hostId, $engine, $configVersion, $json, $signature, [
            'baked_at'       => $bakedAt,
            'binary_version' => $payload['wrapper']['version'] ?? null,
            'etag'           => $etag,
            'size_bytes'     => strlen($json),
        ]);

        $this->touchHost($hostId, $configVersion, $bakedAt);
        return $meta;
    }

    /** @return array<string,mixed> */
    private function orchestratorBlock(string $baseUrl, string $apiKey, bool $allowInsecure): array
    {
        return [
            'base_url'        => rtrim($baseUrl, '/'),
            'api_key'         => $apiKey,
            'ca_bundle_path'  => null,
            'allow_insecure'  => $allowInsecure,
            'installation_id' => $this->installationId,
        ];
    }

    /**
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    private function engineOptions(array $host, string $engine): array
    {
        $silent = (bool) ($this->versions->get('cdx_silent') === '1');
        $theme = trim((string) ($this->versions->get('admin_theme') ?? '')) ?: null;
        $model = $this->nonEmpty($host['model_override'] ?? null);
        $effort = $this->nonEmpty($host['reasoning_effort_override'] ?? null);
        $claudeModel = $this->nonEmpty($host['claude_model_override'] ?? null);

        if ($engine === Engine::CLAUDE) {
            return [
                'silent'                => $silent,
                'claude_model_override' => $claudeModel,
                'admin_theme_hint'      => $theme,
            ];
        }
        return [
            'silent'                    => $silent,
            'model_override'            => $model,
            'reasoning_effort_override' => $effort,
            'admin_theme_hint'          => $theme,
        ];
    }

    /** @return array<string,mixed> */
    private function wrapperBlock(string $engine, string $publicBaseUrl): array
    {
        // The published binary for this engine is the manifest's "current" amd64
        // build; the bootstrap shim picks the actual platform at install time.
        $version = $this->binaries->latestVersion($engine, 'linux', 'amd64')
            ?? $this->binaries->latestVersion($engine, 'linux', 'arm64')
            ?? $this->binaries->latestVersion($engine, 'darwin', 'arm64')
            ?? '0.0.0';

        $sha = $this->binaries->sha256($engine, 'linux', 'amd64', $version)
            ?? str_repeat('0', 64);

        $autoUpdate = ($this->versions->get('auto_update_default') ?? '1') === '1';
        $track = trim((string) ($this->versions->get('wrapper_track') ?? '')) ?: 'stable';

        $url = rtrim($publicBaseUrl, '/') . "/wrapper/v2/bin/$engine/linux-amd64/v$version/$engine";
        return [
            'version'       => $version,
            'track'         => $track,
            'auto_update'   => $autoUpdate,
            'binary_url'    => $url,
            'binary_sha256' => $sha,
        ];
    }

    private function nonEmpty(mixed $v): ?string
    {
        if (!is_string($v)) {
            return null;
        }
        $t = trim($v);
        return $t === '' ? null : $t;
    }

    /** Atomically increment hosts.config_version and return the new value. */
    private function bumpConfigVersion(int $hostId): int
    {
        $upd = $this->pdo->prepare('UPDATE hosts SET config_version = config_version + 1 WHERE id = :id');
        $upd->execute(['id' => $hostId]);
        $sel = $this->pdo->prepare('SELECT config_version FROM hosts WHERE id = :id');
        $sel->execute(['id' => $hostId]);
        return (int) $sel->fetchColumn();
    }

    private function touchHost(int $hostId, int $configVersion, string $bakedAt): void
    {
        $stmt = $this->pdo->prepare('UPDATE hosts SET config_baked_at = :baked_at WHERE id = :id AND config_version = :cv');
        $stmt->execute(['baked_at' => $bakedAt, 'id' => $hostId, 'cv' => $configVersion]);
    }
}
