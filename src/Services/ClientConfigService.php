<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Exceptions\ValidationException;
use App\Repositories\ClientConfigRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;

class ClientConfigService
{
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
        private readonly ?VersionRepository $versions = null
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

        return [
            'status' => 'ok',
            'sha256' => $sha,
            'updated_at' => $row['updated_at'] ?? null,
            'size_bytes' => strlen($body),
            'content' => $body,
            'settings' => $row['settings'] ?? null,
        ];
    }

    public function render(array $settings): array
    {
        $normalized = $this->normalizeSettings($settings);
        $content = $this->buildToml($normalized);
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
        $normalized = $this->normalizeSettings($settings);
        $withManaged = $this->injectManagedMcp($normalized, $baseUrl, $apiKey);
        $content = $this->buildToml($withManaged);
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

        $modelOverride = $this->normalizeString($host['model_override'] ?? null);
        $effortOverride = $this->normalizeString($host['reasoning_effort_override'] ?? null);
        if ($modelOverride === null && $effortOverride === null) {
            return $settings;
        }

        if ($modelOverride !== null) {
            $settings['model'] = $modelOverride;
        }
        if ($effortOverride !== null) {
            $settings['model_reasoning_effort'] = $effortOverride;
        }

        $activeProfile = $this->normalizeString($settings['profile'] ?? null);
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
            $name = $this->normalizeString($entry['name'] ?? null);
            if ($name !== null && hash_equals($activeProfile, $name)) {
                if ($modelOverride !== null) {
                    $entry['model'] = $modelOverride;
                }
                if ($effortOverride !== null) {
                    $entry['model_reasoning_effort'] = $effortOverride;
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
            $this->settingsHash($existing['settings'] ?? []),
            $this->settingsHash($rendered['settings'] ?? [])
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
        $model = $this->normalizeString($settings['model'] ?? null);
        $effort = $this->normalizeString($settings['model_reasoning_effort'] ?? null);
        if ($model !== null) {
            $this->versions->set('cdx_model', $model);
        }
        if ($effort !== null) {
            $this->versions->set('cdx_reasoning_effort', $effort);
        }
    }

    public function retrieve(?string $sha256, ?array $host = null, ?string $baseUrl = null, ?string $apiKey = null): array
    {
        $this->assertSha($sha256, true);

        $row = $this->configs->latest();
        $hostId = $this->hostId($host);

        if ($row === null) {
            $this->logs->log($hostId, 'config.retrieve', ['status' => 'missing']);

            return [
                'status' => 'missing',
            ];
        }

        $body = (string) ($row['body'] ?? '');
        $baseSha = $row['sha256'] ?? hash('sha256', $body);
        $updatedAt = $row['updated_at'] ?? null;

        $cacheKey = $this->cacheKey($baseSha, $updatedAt, $hostId, $apiKey, $baseUrl);
        $baked = self::$bakeCache[$cacheKey] ?? null;
        if ($baked === null) {
            $settings = $row['settings'] ?? [];
            if (!is_array($settings)) {
                $settings = [];
            }
            $rendered = $this->renderForHost($settings, $host, $baseUrl, $apiKey);
            $baked = [
                'sha256' => $rendered['sha256'],
                'size_bytes' => $rendered['size_bytes'],
                'content' => $rendered['content'],
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

    private function cacheKey(string $baseSha, ?string $updatedAt, ?int $hostId, ?string $apiKey, ?string $baseUrl): string
    {
        $keyHash = hash('sha256', (string) $apiKey);
        return implode('|', [
            $baseSha,
            $updatedAt ?? '',
            $hostId ?? 0,
            $keyHash,
            $this->normalizeString($baseUrl) ?? '',
        ]);
    }

    private function injectManagedMcp(array $settings, ?string $baseUrl, ?string $apiKey): array
    {
        $enabled = $settings['orchestrator_mcp_enabled'] ?? true;
        $normalizedBase = $this->normalizeString($baseUrl);
        $key = $this->normalizeString($apiKey);

        if ($enabled === false || $normalizedBase === null || $normalizedBase === '' || $key === null || $key === '') {
            return $settings;
        }

        // Streamable HTTP MCP (no npm dependency). Codex will call our API directly.
        $entry = [
            'name' => 'cdx',
            'url' => rtrim($normalizedBase, '/') . '/mcp',
            // Codex streamable_http supports static headers; embed Authorization header.
            'http_headers' => [
                'Authorization' => 'Bearer ' . $key,
            ],
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

    private function hostId(?array $host): ?int
    {
        $hostId = $host['id'] ?? null;
        return is_numeric($hostId) ? (int) $hostId : null;
    }

    private function normalizeSettings(array $settings): array
    {
        $normalizeString = fn ($value): ?string => $this->normalizeString($value);
        $normalizeBool = fn ($value, ?bool $default = null): ?bool => $this->normalizeBool($value, $default);

        $result = [
            'model' => $normalizeString($settings['model'] ?? null),
            'model_provider' => $normalizeString($settings['model_provider'] ?? null),
            'profile' => $normalizeString($settings['profile'] ?? null),
            'approval_policy' => $normalizeString($settings['approval_policy'] ?? null),
            'sandbox_mode' => $normalizeString($settings['sandbox_mode'] ?? null),
            'model_reasoning_effort' => $normalizeString($settings['model_reasoning_effort'] ?? null),
            'model_reasoning_summary' => null, // set after model-aware normalization
            'model_verbosity' => $normalizeString($settings['model_verbosity'] ?? null),
            'model_supports_reasoning_summaries' => $normalizeBool($settings['model_supports_reasoning_summaries'] ?? null),
            'model_context_window' => $this->normalizeInt($settings['model_context_window'] ?? null),
            'model_max_output_tokens' => $this->normalizeInt($settings['model_max_output_tokens'] ?? null),
            'notify' => $this->normalizeStringList($settings['notify'] ?? []),
            'orchestrator_mcp_enabled' => $normalizeBool($settings['orchestrator_mcp_enabled'] ?? null, true),
        ];
        if (is_array($result['notify'])) {
            $result['notify'] = array_values($result['notify']);
        }

        $result['model_reasoning_summary'] = $this->normalizeReasoningSummary(
            $settings['model_reasoning_summary'] ?? null,
            $result['model']
        );

        $noticeRaw = is_array($settings['notice'] ?? null) ? $settings['notice'] : [];
        $noticeDefaults = [
            'hide_gpt5_1_migration_prompt' => true,
            'hide_gpt-5.1-codex-max_migration_prompt' => true,
            'hide_rate_limit_model_nudge' => true,
        ];
        $notice = [];
        foreach ($noticeDefaults as $key => $default) {
            $candidate = array_key_exists($key, $noticeRaw) ? $noticeRaw[$key] : $default;
            $notice[$key] = $normalizeBool($candidate, $default) ?? $default;
        }
        foreach ($noticeRaw as $key => $value) {
            if (array_key_exists($key, $notice)) {
                $override = $normalizeBool($value, $notice[$key]);
                if ($override !== null) {
                    $notice[$key] = $override;
                }
                continue;
            }
            $boolValue = $normalizeBool($value);
            if ($boolValue !== null) {
                $notice[(string) $key] = $boolValue;
            }
        }
        $result['notice'] = $notice;

        $featuresRaw = is_array($settings['features'] ?? null) ? $settings['features'] : [];
        $features = [];
        foreach ($featuresRaw as $key => $value) {
            $boolValue = $normalizeBool($value);
            if ($boolValue === null) {
                continue;
            }
            $name = $normalizeString((string) $key);
            if ($name === null || $name === '') {
                continue;
            }
            $features[$name] = $boolValue;
        }
        $result['features'] = $features;

        $sandboxRaw = is_array($settings['sandbox_workspace_write'] ?? null) ? $settings['sandbox_workspace_write'] : [];
        $result['sandbox_workspace_write'] = [
            'network_access' => $normalizeBool($sandboxRaw['network_access'] ?? null),
            'exclude_tmpdir_env_var' => $normalizeBool($sandboxRaw['exclude_tmpdir_env_var'] ?? null),
            'exclude_slash_tmp' => $normalizeBool($sandboxRaw['exclude_slash_tmp'] ?? null),
            'writable_roots' => $this->normalizeStringList($sandboxRaw['writable_roots'] ?? []),
        ];

        $envRaw = is_array($settings['shell_environment_policy'] ?? null) ? $settings['shell_environment_policy'] : [];
        $result['shell_environment_policy'] = [
            'inherit' => $normalizeString($envRaw['inherit'] ?? null),
            'set' => $this->normalizeStringMap($envRaw['set'] ?? []),
            'ignore_default_excludes' => $normalizeBool($envRaw['ignore_default_excludes'] ?? null),
            'exclude' => $this->normalizeStringList($envRaw['exclude'] ?? []),
            'include_only' => $this->normalizeStringList($envRaw['include_only'] ?? []),
        ];

        $profilesRaw = is_array($settings['profiles'] ?? null) ? $settings['profiles'] : [];
        $profiles = [];
        foreach ($profilesRaw as $entry) {
            if (!is_array($entry)) {
                continue;
            }
            $name = $normalizeString($entry['name'] ?? null);
            if ($name === null || $name === '') {
                continue;
            }

            $profileModel = $normalizeString($entry['model'] ?? null);
            $profileFeaturesRaw = is_array($entry['features'] ?? null) ? $entry['features'] : [];
            $profileFeatures = [];
            foreach ($profileFeaturesRaw as $key => $value) {
                $boolValue = $normalizeBool($value);
                if ($boolValue === null) {
                    continue;
                }
                $featureName = $normalizeString((string) $key);
                if ($featureName === null || $featureName === '') {
                    continue;
                }
                $profileFeatures[$featureName] = $boolValue;
            }

            $profileSandboxRaw = is_array($entry['sandbox_workspace_write'] ?? null) ? $entry['sandbox_workspace_write'] : [];
            $profiles[] = [
                'name' => $name,
                'model' => $profileModel,
                'approval_policy' => $normalizeString($entry['approval_policy'] ?? null),
                'sandbox_mode' => $normalizeString($entry['sandbox_mode'] ?? null),
                'model_reasoning_effort' => $normalizeString($entry['model_reasoning_effort'] ?? null),
                'model_reasoning_summary' => $this->normalizeReasoningSummary($entry['model_reasoning_summary'] ?? null, $profileModel),
                'model_verbosity' => $normalizeString($entry['model_verbosity'] ?? null),
                'model_supports_reasoning_summaries' => $normalizeBool($entry['model_supports_reasoning_summaries'] ?? null),
                'model_context_window' => $this->normalizeInt($entry['model_context_window'] ?? null),
                'model_max_output_tokens' => $this->normalizeInt($entry['model_max_output_tokens'] ?? null),
                'features' => $profileFeatures,
                'sandbox_workspace_write' => [
                    'network_access' => $normalizeBool($profileSandboxRaw['network_access'] ?? null),
                ],
            ];
        }
        $result['profiles'] = $profiles;

        $mcpRaw = is_array($settings['mcp_servers'] ?? null) ? $settings['mcp_servers'] : [];
        $mcpServers = [];
        foreach ($mcpRaw as $entry) {
            if (!is_array($entry)) {
                continue;
            }
            $name = $normalizeString($entry['name'] ?? null);
            if ($name === null || $name === '') {
                continue;
            }

            $server = [
                'name' => $name,
                'command' => $normalizeString($entry['command'] ?? null),
                'args' => $this->normalizeStringList($entry['args'] ?? []),
                'url' => $normalizeString($entry['url'] ?? null),
                'bearer_token' => $normalizeString($entry['bearer_token'] ?? null),
                'bearer_token_env_var' => $normalizeString($entry['bearer_token_env_var'] ?? null),
                'http_headers' => $this->normalizeStringMap($entry['http_headers'] ?? []),
                'env_http_headers' => $this->normalizeStringMap($entry['env_http_headers'] ?? []),
                'enabled' => $normalizeBool($entry['enabled'] ?? null),
                'startup_timeout_sec' => $this->normalizeInt($entry['startup_timeout_sec'] ?? null),
                'tool_timeout_sec' => $this->normalizeInt($entry['tool_timeout_sec'] ?? null),
            ];

            // Drop impossible transport combos
            if (($server['command'] === null || $server['command'] === '') && ($server['url'] === null || $server['url'] === '')) {
                continue;
            }

            $mcpServers[] = $server;
        }
        $result['mcp_servers'] = $mcpServers;

        $otelRaw = is_array($settings['otel'] ?? null) ? $settings['otel'] : [];
        $result['otel'] = [
            'environment' => $normalizeString($otelRaw['environment'] ?? null),
            'exporter' => $normalizeString($otelRaw['exporter'] ?? null),
            'endpoint' => $normalizeString($otelRaw['endpoint'] ?? null),
            'protocol' => $normalizeString($otelRaw['protocol'] ?? null),
            'headers' => $this->normalizeStringMap($otelRaw['headers'] ?? []),
            'log_user_prompt' => $normalizeBool($otelRaw['log_user_prompt'] ?? null),
        ];

        $customToml = $settings['custom_toml'] ?? null;
        $result['custom_toml'] = is_string($customToml) ? trim($customToml) : '';

        return $result;
    }

    private function buildToml(array $settings): string
    {
        $lines = [];

        $rootKeys = [
            'model',
            'model_provider',
            'profile',
            'approval_policy',
            'sandbox_mode',
            'model_reasoning_effort',
            'model_reasoning_summary',
            'model_verbosity',
            'model_supports_reasoning_summaries',
            'model_context_window',
            'model_max_output_tokens',
        ];

        $notify = $settings['notify'] ?? [];
        if (is_array($notify) && $this->isAssoc($notify)) {
            $notify = array_values($notify);
        }
        $settings['notify'] = $notify;

        foreach ($rootKeys as $key) {
            $this->addKeyValue($lines, $key, $settings[$key] ?? null);
        }

        $this->addKeyValue($lines, 'notify', $settings['notify'] ?? null);

        if ($this->hasAny($settings['features'] ?? [])) {
            $this->addBlankLine($lines);
            $lines[] = '[features]';
            foreach ($this->sortedAssoc($settings['features']) as $key => $value) {
                $this->addKeyValue($lines, (string) $key, $value);
            }
        }

        if ($this->hasAny($settings['notice'] ?? [])) {
            $this->addBlankLine($lines);
            $lines[] = '[notice]';
            foreach ($this->sortedAssoc($settings['notice']) as $key => $value) {
                $this->addKeyValue($lines, (string) $key, $value);
            }
        }

        if ($this->hasAny($settings['sandbox_workspace_write'] ?? [])) {
            $this->addBlankLine($lines);
            $lines[] = '[sandbox_workspace_write]';
            $sandbox = $settings['sandbox_workspace_write'] ?? [];
            $this->addKeyValue($lines, 'network_access', $sandbox['network_access'] ?? null);
            $this->addKeyValue($lines, 'exclude_tmpdir_env_var', $sandbox['exclude_tmpdir_env_var'] ?? null);
            $this->addKeyValue($lines, 'exclude_slash_tmp', $sandbox['exclude_slash_tmp'] ?? null);
            $this->addKeyValue($lines, 'writable_roots', $sandbox['writable_roots'] ?? null);
        }

        if ($this->hasAny($settings['shell_environment_policy'] ?? [])) {
            $this->addBlankLine($lines);
            $lines[] = '[shell_environment_policy]';
            $env = $settings['shell_environment_policy'] ?? [];
            $this->addKeyValue($lines, 'inherit', $env['inherit'] ?? null);
            $this->addInlineTable($lines, 'set', $env['set'] ?? []);
            $this->addKeyValue($lines, 'ignore_default_excludes', $env['ignore_default_excludes'] ?? null);
            $this->addKeyValue($lines, 'exclude', $env['exclude'] ?? null);
            $this->addKeyValue($lines, 'include_only', $env['include_only'] ?? null);
        }

        $profiles = $settings['profiles'] ?? [];
        if (is_array($profiles) && count($profiles) > 0) {
            foreach ($this->sortEntriesByName($profiles) as $profile) {
                $name = $profile['name'] ?? null;
                if ($name === null || $name === '') {
                    continue;
                }
                $this->addBlankLine($lines);
                $profileKey = $this->formatKey($name);
                $lines[] = '[profiles.' . $profileKey . ']';
                $this->addKeyValue($lines, 'model', $profile['model'] ?? null);
                $this->addKeyValue($lines, 'approval_policy', $profile['approval_policy'] ?? null);
                $this->addKeyValue($lines, 'sandbox_mode', $profile['sandbox_mode'] ?? null);
                $this->addKeyValue($lines, 'model_reasoning_effort', $profile['model_reasoning_effort'] ?? null);
                $this->addKeyValue($lines, 'model_reasoning_summary', $profile['model_reasoning_summary'] ?? null);
                $this->addKeyValue($lines, 'model_verbosity', $profile['model_verbosity'] ?? null);
                $this->addKeyValue($lines, 'model_supports_reasoning_summaries', $profile['model_supports_reasoning_summaries'] ?? null);
                $this->addKeyValue($lines, 'model_context_window', $profile['model_context_window'] ?? null);
                $this->addKeyValue($lines, 'model_max_output_tokens', $profile['model_max_output_tokens'] ?? null);

                if ($this->hasAny($profile['features'] ?? [])) {
                    $this->addBlankLine($lines);
                    $lines[] = '[profiles.' . $profileKey . '.features]';
                    foreach ($this->sortedAssoc($profile['features'] ?? []) as $key => $value) {
                        $this->addKeyValue($lines, (string) $key, $value);
                    }
                }

                if ($this->hasAny($profile['sandbox_workspace_write'] ?? [])) {
                    $this->addBlankLine($lines);
                    $lines[] = '[profiles.' . $profileKey . '.sandbox_workspace_write]';
                    $sandbox = $profile['sandbox_workspace_write'] ?? [];
                    $this->addKeyValue($lines, 'network_access', $sandbox['network_access'] ?? null);
                }
            }
        }

        $mcpServers = $settings['mcp_servers'] ?? [];
        if (is_array($mcpServers) && count($mcpServers) > 0) {
            foreach ($this->sortEntriesByName($mcpServers) as $entry) {
                $name = $entry['name'] ?? null;
                if ($name === null || $name === '') {
                    continue;
                }
                $this->addBlankLine($lines);
                $lines[] = '[mcp_servers.' . $this->formatKey($name) . ']';
                $this->addKeyValue($lines, 'command', $entry['command'] ?? null);
                $this->addKeyValue($lines, 'args', $entry['args'] ?? null);
                $this->addKeyValue($lines, 'url', $entry['url'] ?? null);
                $this->addKeyValue($lines, 'bearer_token_env_var', $entry['bearer_token_env_var'] ?? null);
                $this->addInlineTable($lines, 'http_headers', $entry['http_headers'] ?? []);
                $this->addInlineTable($lines, 'env_http_headers', $entry['env_http_headers'] ?? []);
                $this->addKeyValue($lines, 'enabled', $entry['enabled'] ?? null);
                $this->addKeyValue($lines, 'startup_timeout_sec', $entry['startup_timeout_sec'] ?? null);
                $this->addKeyValue($lines, 'tool_timeout_sec', $entry['tool_timeout_sec'] ?? null);
            }
        }

        $otel = $settings['otel'] ?? [];
        if ($this->hasAny($otel)) {
            $this->addBlankLine($lines);
            $lines[] = '[otel]';
            $this->addKeyValue($lines, 'environment', $otel['environment'] ?? null);
            $exporter = $otel['exporter'] ?? null;
            $endpoint = $otel['endpoint'] ?? null;
            $headers = $otel['headers'] ?? [];
            $protocol = $otel['protocol'] ?? null;
            if ($exporter === 'otlp-http' && $endpoint !== null) {
                $httpConfig = ['endpoint' => $endpoint];
                if ($protocol !== null) {
                    $httpConfig['protocol'] = $protocol;
                }
                if ($this->hasAny($headers)) {
                    $httpConfig['headers'] = $headers;
                }
                $this->addInlineTable($lines, 'exporter', ['otlp-http' => $httpConfig]);
            } elseif ($exporter === 'otlp-grpc' && $endpoint !== null) {
                $grpcConfig = ['endpoint' => $endpoint];
                if ($this->hasAny($headers)) {
                    $grpcConfig['headers'] = $headers;
                }
                $this->addInlineTable($lines, 'exporter', ['otlp-grpc' => $grpcConfig]);
            } else {
                $this->addKeyValue($lines, 'exporter', $exporter ?? 'none');
            }
            $this->addKeyValue($lines, 'log_user_prompt', $otel['log_user_prompt'] ?? null);
        }

        if (isset($settings['custom_toml']) && trim((string) $settings['custom_toml']) !== '') {
            $this->addBlankLine($lines);
            $custom = rtrim((string) $settings['custom_toml']) . "\n";
            $lines[] = rtrim($custom, "\n");
        }

        $content = implode("\n", array_filter($lines, static fn ($line) => $line !== null));
        return rtrim($content) . "\n";
    }

    private function addKeyValue(array &$lines, string $key, mixed $value): void
    {
        if ($value === null || $value === '') {
            return;
        }

        $lines[] = $this->formatKey($key) . ' = ' . $this->formatValue($value);
    }

    private function addInlineTable(array &$lines, string $key, mixed $value): void
    {
        if (!is_array($value) || !$this->hasAny($value)) {
            return;
        }

        $lines[] = $this->formatKey($key) . ' = ' . $this->formatInlineTable($value);
    }

    private function formatValue(mixed $value): string
    {
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_int($value)) {
            return (string) $value;
        }
        if (is_float($value)) {
            return rtrim(rtrim(sprintf('%.6F', $value), '0'), '.');
        }
        if (is_array($value)) {
            if ($value === []) {
                return '[]';
            }
            if ($this->isAssoc($value)) {
                return $this->formatInlineTable($value);
            }
            $parts = [];
            foreach ($value as $item) {
                $parts[] = $this->formatValue($item);
            }
            return '[' . implode(', ', $parts) . ']';
        }

        return '"' . $this->escapeString((string) $value) . '"';
    }

    private function formatInlineTable(array $map): string
    {
        $pairs = [];
        foreach ($this->sortedAssoc($map) as $key => $value) {
            $pairs[] = $this->formatKey((string) $key) . ' = ' . $this->formatValue($value);
        }
        return '{ ' . implode(', ', $pairs) . ' }';
    }

    private function formatKey(string $key): string
    {
        if (preg_match('/^[A-Za-z0-9_-]+$/', $key) === 1) {
            return $key;
        }

        return '"' . $this->escapeString($key) . '"';
    }

    private function escapeString(string $value): string
    {
        $replaced = str_replace(
            ['\\', '"', "\n", "\r", "\t"],
            ['\\\\', '\\"', '\\n', '\\r', '\\t'],
            $value
        );

        return $replaced;
    }

    private function isAssoc(array $value): bool
    {
        return array_keys($value) !== range(0, count($value) - 1);
    }

    private function hasAny(mixed $value): bool
    {
        if ($value === null) {
            return false;
        }
        if (is_array($value)) {
            foreach ($value as $item) {
                if ($item === null || $item === '') {
                    continue;
                }
                if (is_array($item) && !$this->hasAny($item)) {
                    continue;
                }
                return true;
            }
            return false;
        }

        return (bool) $value;
    }

    private function addBlankLine(array &$lines): void
    {
        if (empty($lines)) {
            return;
        }
        if (end($lines) !== '') {
            $lines[] = '';
        }
    }

    private function normalizeString(mixed $value): ?string
    {
        if (!is_string($value) && !is_numeric($value)) {
            return null;
        }
        $str = trim((string) $value);
        return $str === '' ? null : $str;
    }

    private function normalizeBool(mixed $value, ?bool $default = null): ?bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) {
                return true;
            }
            if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) {
                return false;
            }
        }
        if (is_int($value)) {
            return $value !== 0;
        }

        return $default;
    }

    private function normalizeReasoningSummary(mixed $value, ?string $model = null): ?string
    {
        $normalized = $this->normalizeString($value);
        if ($normalized === null) {
            return null;
        }

        $lower = strtolower($normalized);
        if ($lower === 'none') {
            return null;
        }

        $allowed = ['auto', 'concise', 'detailed'];
        if (!in_array($lower, $allowed, true)) {
            return null;
        }

        if ($model !== null && $this->isGpt51CodexModel($model)) {
            // gpt-5.1/5.2-codex* only support detailed summaries.
            return 'detailed';
        }

        return $lower;
    }

    private function isGpt51CodexModel(string $model): bool
    {
        $m = strtolower(trim($model));
        return str_starts_with($m, 'gpt-5.1-codex') || str_starts_with($m, 'gpt-5.2-codex');
    }

    private function normalizeInt(mixed $value): ?int
    {
        if (is_int($value)) {
            return $value;
        }
        if (is_string($value) && preg_match('/^-?[0-9]+$/', trim($value)) === 1) {
            return (int) $value;
        }

        return null;
    }

    private function normalizeStringList(mixed $value): array
    {
        $result = [];
        if (is_array($value)) {
            foreach ($value as $item) {
                $str = $this->normalizeString($item);
                if ($str !== null && $str !== '') {
                    $result[] = $str;
                }
            }
        } elseif (is_string($value)) {
            $parts = preg_split('/[\r\n]+/', $value) ?: [];
            foreach ($parts as $part) {
                $str = $this->normalizeString($part);
                if ($str !== null && $str !== '') {
                    $result[] = $str;
                }
            }
        }

        return array_values(array_unique($result));
    }

    private function normalizeStringMap(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $result = [];
        foreach ($value as $key => $val) {
            $name = $this->normalizeString((string) $key);
            if ($name === null || $name === '') {
                continue;
            }
            if (is_bool($val) || is_int($val) || is_float($val)) {
                $result[$name] = $val;
                continue;
            }
            $result[$name] = (string) $val;
        }

        ksort($result);

        return $result;
    }

    private function assertSha(?string $sha, bool $allowNull = false, array &$errors = []): void
    {
        if ($sha === null) {
            if ($allowNull) {
                return;
            }
            $errors['sha256'][] = 'sha256 is required';
            if ($errors) {
                throw new ValidationException($errors);
            }
            return;
        }

        $value = trim($sha);
        if ($value !== '' && !preg_match('/^[A-Fa-f0-9]{64}$/', $value)) {
            $errors['sha256'][] = 'sha256 must be 64 hex characters';
        }

        if ($errors) {
            throw new ValidationException($errors);
        }
    }

    private function settingsHash(mixed $settings): string
    {
        $normalized = $this->normalizeForHash($settings);
        $encoded = json_encode($normalized, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        return hash('sha256', $encoded === false ? '' : $encoded);
    }

    private function normalizeForHash(mixed $value): mixed
    {
        if (is_array($value)) {
            $result = $value;
            if ($this->isAssoc($value)) {
                ksort($result, SORT_NATURAL);
            }

            foreach ($result as $key => $child) {
                $result[$key] = $this->normalizeForHash($child);
            }

            return $result;
        }

        if (is_bool($value) || is_int($value) || is_float($value) || $value === null) {
            return $value;
        }

        return (string) $value;
    }

    /**
     * @param array<int|string, mixed> $map
     *
     * @return array<int|string, mixed>
     */
    private function sortedAssoc(array $map): array
    {
        if (!$this->isAssoc($map)) {
            return $map;
        }
        ksort($map, SORT_NATURAL);

        return $map;
    }

    /**
     * @param array<int, array<string, mixed>> $entries
     *
     * @return array<int, array<string, mixed>>
     */
    private function sortEntriesByName(array $entries): array
    {
        usort($entries, static function ($a, $b): int {
            $aKey = (string) ($a['name'] ?? '');
            $bKey = (string) ($b['name'] ?? '');
            return strcmp($aKey, $bKey);
        });

        return $entries;
    }
}
