<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Config;
use App\Exceptions\ValidationException;
use App\Repositories\ClientConfigRepository;
use App\Repositories\LogRepository;
use App\Repositories\McpSessionTokenRepository;
use App\Repositories\VersionRepository;

class ClientConfigService
{
    /** @var list<string> */
    public const SUPPORTED_MODELS = ConfigNormalizer::SUPPORTED_MODELS;

    /** @var array<string, list<string>> */
    public const MODEL_REASONING_EFFORTS = ConfigNormalizer::MODEL_REASONING_EFFORTS;

    /** @var list<string> */
    public const REASONING_EFFORTS = ConfigNormalizer::REASONING_EFFORTS;

    /** @var list<string> */
    public const PERSONALITIES = ConfigNormalizer::PERSONALITIES;

    /**
     * Per-request cache for baked configs so multiple calls in one request
     * don't rebuild TOML (keyed by base sha + host + api key hash + base URL).
     *
     * @var array<string, array{sha256:string, size_bytes:int, content:string, updated_at:?string, base_sha:string}>
     */
    private static array $bakeCache = [];

    public function __construct(
        private readonly ClientConfigRepository $configs,
        private readonly LogRepository $logs,
        private readonly ?VersionRepository $versions = null,
        private readonly ?McpSessionTokenRepository $mcpSessionTokens = null,
        private readonly ConfigNormalizer $normalizer = new ConfigNormalizer(),
        private readonly TomlRenderer $tomlRenderer = new TomlRenderer()
    ) {
    }

    public function adminFetch(): array
    {
        $row = $this->configs->latest();
        if ($row === null) {
            return [
                'status' => 'missing',
            ];
        }

        $body = (string) ($row['body'] ?? '');
        $sha = $row['sha256'] ?? hash('sha256', $body);
        $settings = $row['settings'] ?? null;
        $normalizedSettings = is_array($settings) ? $this->normalizer->normalizeSettings($settings) : null;

        return [
            'status' => 'ok',
            'sha256' => $sha,
            'updated_at' => $row['updated_at'] ?? null,
            'size_bytes' => strlen($body),
            'content' => $body,
            'settings' => $normalizedSettings,
        ];
    }

    public function render(array $settings): array
    {
        $normalized = $this->normalizer->normalizeSettings($settings);
        $content = $this->tomlRenderer->buildToml($normalized);
        $sha = hash('sha256', $content);

        return [
            'content' => $content,
            'sha256' => $sha,
            'size_bytes' => strlen($content),
            'settings' => $normalized,
        ];
    }

    public function renderForHost(array $settings, ?array $host, ?string $baseUrl, ?string $apiKey): array
    {
        $settings = $this->applyHostModelOverrides($settings, $host);
        $normalized = $this->normalizer->normalizeSettings($settings);
        $withManaged = $this->injectManagedMcp($normalized, $baseUrl, $apiKey, $host);
        $content = $this->tomlRenderer->buildToml($withManaged);
        $sha = hash('sha256', $content);

        return [
            'content' => $content,
            'sha256' => $sha,
            'size_bytes' => strlen($content),
            'settings' => $normalized,
        ];
    }

    private function applyHostModelOverrides(array $settings, ?array $host): array
    {
        if (!is_array($host)) {
            return $settings;
        }

        $modelOverride = self::normalizeSupportedModel($host['model_override'] ?? null);
        $effectiveModel = $modelOverride ?? self::normalizeSupportedModel($settings['model'] ?? null);
        $effortOverrideRaw = self::normalizeReasoningEffort($host['reasoning_effort_override'] ?? null);
        $effortOverride = $this->normalizer->normalizeReasoningEffortForModel($effortOverrideRaw, $effectiveModel);
        if ($modelOverride === null && $effortOverride === null) {
            return $settings;
        }

        if ($modelOverride !== null) {
            $settings['model'] = $modelOverride;
        }
        if ($effortOverride !== null) {
            $settings['model_reasoning_effort'] = $effortOverride;
        }

        $activeProfile = $this->normalizer->normalizeString($settings['profile'] ?? null);
        if ($activeProfile === null) {
            return $settings;
        }

        $profiles = $settings['profiles'] ?? null;
        if (!is_array($profiles)) {
            return $settings;
        }

        $updatedProfiles = [];
        foreach ($profiles as $entry) {
            if (!is_array($entry)) {
                $updatedProfiles[] = $entry;
                continue;
            }
            $name = $this->normalizer->normalizeString($entry['name'] ?? null);
            if ($name !== null && hash_equals($activeProfile, $name)) {
                $profileModel = $modelOverride ?? self::normalizeSupportedModel($entry['model'] ?? null);
                $profileEffort = $this->normalizer->normalizeReasoningEffortForModel($effortOverrideRaw, $profileModel);
                if ($modelOverride !== null) {
                    $entry['model'] = $modelOverride;
                }
                if ($profileEffort !== null) {
                    $entry['model_reasoning_effort'] = $profileEffort;
                }
            }
            $updatedProfiles[] = $entry;
        }
        $settings['profiles'] = $updatedProfiles;

        return $settings;
    }

    public function store(array $payload, ?array $host = null): array
    {
        $settingsRaw = is_array($payload['settings'] ?? null) ? $payload['settings'] : [];
        $providedSha = $payload['sha256'] ?? null;
        $rendered = $this->render($settingsRaw);

        $existing = $this->configs->latest();
        $existingSha = $existing['sha256'] ?? null;

        $errors = [];
        if ($providedSha !== null) {
            $normalizedProvided = strtolower(trim((string) $providedSha));
            if ($normalizedProvided === '' || !preg_match('/^[a-f0-9]{64}$/', $normalizedProvided)) {
                $errors['sha256'][] = 'sha256 must be 64 hex characters when provided';
            } elseif ($existing !== null && !hash_equals($normalizedProvided, strtolower((string) $existingSha))) {
                $errors['sha256'][] = 'sha256 does not match current saved config.toml (reload before saving)';
            }
        }

        if ($rendered['content'] === '') {
            $errors['settings'][] = 'config cannot be empty';
        }

        if ($errors) {
            throw new ValidationException($errors);
        }

        $contentUnchanged = $existing !== null && hash_equals((string) $existingSha, $rendered['sha256']);
        $settingsUnchanged = $existing !== null && hash_equals(
            $this->normalizer->settingsHash($existing['settings'] ?? []),
            $this->normalizer->settingsHash($rendered['settings'] ?? [])
        );

        $status = $existing === null ? 'created' : (($contentUnchanged && $settingsUnchanged) ? 'unchanged' : 'updated');
        $hostId = $this->hostId($host);

        $saved = $status === 'unchanged'
            ? $existing
            : $this->configs->upsert($rendered['content'], $rendered['settings'], $hostId, $rendered['sha256']);

        $this->logs->log($hostId, 'config.store', ['status' => $status]);
        if ($status !== 'unchanged') {
            $this->writeGlobalModelDefaults($rendered['settings'] ?? []);
        }

        $body = (string) ($saved['body'] ?? $rendered['content']);
        $sha = $saved['sha256'] ?? $rendered['sha256'];

        return [
            'status' => $status,
            'sha256' => $sha,
            'updated_at' => $saved['updated_at'] ?? gmdate(DATE_ATOM),
            'size_bytes' => strlen($body),
            'content' => $body,
            'settings' => $saved['settings'] ?? $rendered['settings'],
        ];
    }

    private function writeGlobalModelDefaults(array $settings): void
    {
        if ($this->versions === null) {
            return;
        }
        $model = $this->normalizer->normalizeString($settings['model'] ?? null);
        $effort = $this->normalizer->normalizeString($settings['model_reasoning_effort'] ?? null);
        if ($model !== null) {
            $this->versions->set('cdx_model', $model);
        }
        if ($effort !== null) {
            $this->versions->set('cdx_reasoning_effort', $effort);
        }
    }

    public function retrieve(
        ?string $sha256,
        ?array $host = null,
        ?string $baseUrl = null,
        ?string $apiKey = null,
        ?string $username = null,
        ?string $home = null
    ): array
    {
        $this->normalizer->assertSha($sha256, true);

        $row = $this->configs->latest();
        $hostId = $this->hostId($host);
        $homePath = $this->tomlRenderer->normalizeHomePath($home, $username);

        if ($row === null) {
            $this->logs->log($hostId, 'config.retrieve', ['status' => 'missing']);

            return [
                'status' => 'missing',
            ];
        }

        $body = (string) ($row['body'] ?? '');
        $baseSha = $row['sha256'] ?? hash('sha256', $body);
        $updatedAt = $row['updated_at'] ?? null;

        $cacheKey = $this->cacheKey($baseSha, $updatedAt, $hostId, $apiKey, $baseUrl, $homePath);
        $baked = self::$bakeCache[$cacheKey] ?? null;
        if ($baked === null) {
            $settings = $row['settings'] ?? [];
            if (!is_array($settings)) {
                $settings = [];
            }
            $rendered = $this->renderForHost($settings, $host, $baseUrl, $apiKey);
            $content = $this->tomlRenderer->injectTrustedProjectToml($rendered['content'], $homePath);
            $bakedSha = $rendered['sha256'];
            $bakedSize = $rendered['size_bytes'];
            if ($content !== $rendered['content']) {
                $bakedSha = hash('sha256', $content);
                $bakedSize = strlen($content);
            }
            $baked = [
                'sha256' => $bakedSha,
                'size_bytes' => $bakedSize,
                'content' => $content,
                'updated_at' => $updatedAt,
                'base_sha' => $baseSha,
            ];
            self::$bakeCache[$cacheKey] = $baked;
        }

        $bakedStatus = ($sha256 !== null && hash_equals($baked['sha256'], $sha256)) ? 'unchanged' : 'updated';

        $result = [
            'status' => $bakedStatus,
            'sha256' => $baked['sha256'],
            'base_sha256' => $baseSha,
            'updated_at' => $updatedAt,
            'size_bytes' => $baked['size_bytes'],
        ];

        if ($bakedStatus !== 'unchanged') {
            $result['content'] = $baked['content'];
        }

        $this->logs->log($hostId, 'config.retrieve', [
            'status' => $bakedStatus,
            'base_sha256' => $baseSha,
            'baked_sha256' => $baked['sha256'],
        ]);

        return $result;
    }

    public static function resetCache(): void
    {
        self::$bakeCache = [];
    }

    private function cacheKey(
        string $baseSha,
        ?string $updatedAt,
        ?int $hostId,
        ?string $apiKey,
        ?string $baseUrl,
        ?string $homePath
    ): string
    {
        $keyHash = hash('sha256', (string) $apiKey);
        return implode('|', [
            $baseSha,
            $updatedAt ?? '',
            $hostId ?? 0,
            $keyHash,
            $this->normalizer->normalizeString($baseUrl) ?? '',
            $homePath ?? '',
        ]);
    }

    private function injectManagedMcp(array $settings, ?string $baseUrl, ?string $apiKey, ?array $host = null): array
    {
        $enabled = $settings['orchestrator_mcp_enabled'] ?? true;
        $normalizedBase = $this->normalizer->normalizeString($baseUrl);
        $key = $this->normalizer->normalizeString($apiKey);
        $hostSecure = isset($host['secure']) ? (bool) (int) $host['secure'] : true;
        $hostId = isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : null;

        if ($enabled === false || $normalizedBase === null || $normalizedBase === '' || $key === null || $key === '') {
            return $settings;
        }

        $bearer = 'Bearer ' . $key;
        if (!$hostSecure) {
            $ephemeral = $this->issueManagedMcpToken($hostId);
            if ($ephemeral === null) {
                return $settings;
            }
            $bearer = 'Bearer ' . $ephemeral;
        }

        // Streamable HTTP MCP (no npm dependency). Codex will call our API directly.
        $entry = [
            'name' => 'cdx',
            'url' => rtrim($normalizedBase, '/') . '/mcp',
            // Codex streamable_http supports static headers; embed Authorization header.
            'http_headers' => [
                'Authorization' => $bearer,
            ],
            // Codex may block startup while validating MCP servers; give the HTTP endpoint a bit more room.
            'startup_timeout_sec' => 30,
        ];

        $existing = $settings['mcp_servers'] ?? [];
        $filtered = array_values(array_filter(
            is_array($existing) ? $existing : [],
            static function ($item): bool {
                $name = is_array($item) ? ($item['name'] ?? '') : '';
                $normalized = strtolower(trim((string) $name));
                return !in_array($normalized, ['codex-memory', 'codex-orchestrator', 'cdx'], true);
            }
        ));

        array_unshift($filtered, $entry);
        $settings['mcp_servers'] = $filtered;

        return $settings;
    }

    private function issueManagedMcpToken(?int $hostId): ?string
    {
        if ($hostId === null || $hostId <= 0 || $this->mcpSessionTokens === null) {
            return null;
        }

        $ttl = $this->managedMcpTokenTtlSeconds();
        $token = 'mcp_' . bin2hex(random_bytes(24));
        $expiresAt = gmdate(DATE_ATOM, time() + $ttl);
        $this->mcpSessionTokens->deleteExpired(gmdate(DATE_ATOM));
        $created = $this->mcpSessionTokens->create($token, $hostId, $expiresAt);

        return is_string($created['token'] ?? null) ? $created['token'] : $token;
    }

    private function managedMcpTokenTtlSeconds(): int
    {
        $raw = Config::get('MCP_EPHEMERAL_TOKEN_TTL_SECONDS', 900);
        $ttl = is_numeric($raw) ? (int) $raw : 900;
        if ($ttl < 60) {
            return 60;
        }
        if ($ttl > 3600) {
            return 3600;
        }

        return $ttl;
    }

    private function hostId(?array $host): ?int
    {
        $hostId = $host['id'] ?? null;
        return is_numeric($hostId) ? (int) $hostId : null;
    }

    /** @return list<string> */
    public static function supportedModels(): array
    {
        return ConfigNormalizer::supportedModels();
    }

    public static function normalizeSupportedModel(mixed $value): ?string
    {
        return ConfigNormalizer::normalizeSupportedModel($value);
    }

    /** @return list<string> */
    public static function supportedReasoningEffortsForModel(mixed $model): array
    {
        return ConfigNormalizer::supportedReasoningEffortsForModel($model);
    }

    public static function normalizeReasoningEffort(mixed $value): ?string
    {
        return ConfigNormalizer::normalizeReasoningEffort($value);
    }

    public static function modelSupportsReasoningEffort(mixed $model, mixed $effort): bool
    {
        return ConfigNormalizer::modelSupportsReasoningEffort($model, $effort);
    }
}
