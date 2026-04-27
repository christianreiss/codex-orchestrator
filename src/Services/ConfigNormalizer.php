<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Exceptions\ValidationException;

class ConfigNormalizer
{
    public const FORCE_UPGRADE_MODEL = 'gpt-5.4';
    public const FORCE_UPGRADE_REASONING_EFFORT = 'high';

    /** @var list<string> */
    public const SUPPORTED_MODELS = [
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.3-codex',
        'gpt-5.2',
    ];

    /** @var array<string, string> */
    public const LEGACY_MODEL_UPGRADES = [
        'gpt-5.3-codex-spark' => self::FORCE_UPGRADE_MODEL,
        'gpt-5.2-codex' => self::FORCE_UPGRADE_MODEL,
        'gpt-5.1-codex-max' => self::FORCE_UPGRADE_MODEL,
        'gpt-5.1-codex-mini' => self::FORCE_UPGRADE_MODEL,
    ];

    /** @var list<string> */
    public const CLAUDE_SUPPORTED_MODELS = [
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
    ];

    /** @var array<string, string> */
    public const CLAUDE_LEGACY_MODEL_UPGRADES = [
        'claude-3-opus-20240229' => 'claude-opus-4-6',
        'claude-3-sonnet-20240229' => 'claude-sonnet-4-6',
        'claude-3-haiku-20240307' => 'claude-haiku-4-5',
        'claude-3-5-sonnet-20240620' => 'claude-sonnet-4-6',
        'claude-3-5-sonnet-20241022' => 'claude-sonnet-4-6',
        'claude-3-5-haiku-20241022' => 'claude-haiku-4-5',
        'claude-sonnet-4-20250514' => 'claude-sonnet-4-6',
        'claude-opus-4-20250514' => 'claude-opus-4-6',
        'claude-haiku-4-5-20251001' => 'claude-haiku-4-5',
    ];

    /** @var array<string, list<string>> */
    public const MODEL_REASONING_EFFORTS = [
        'gpt-5.5' => ['low', 'medium', 'high', 'xhigh'],
        'gpt-5.4' => ['low', 'medium', 'high', 'xhigh'],
        'gpt-5.4-mini' => ['low', 'medium', 'high', 'xhigh'],
        'gpt-5.3-codex' => ['low', 'medium', 'high', 'xhigh'],
        'gpt-5.2' => ['low', 'medium', 'high', 'xhigh'],
    ];

    /** @var array<string, list<string>> */
    public const CLAUDE_MODEL_REASONING_EFFORTS = [
        'claude-opus-4-6' => ['low', 'medium', 'high'],
        'claude-sonnet-4-6' => ['low', 'medium', 'high'],
        'claude-haiku-4-5' => ['low', 'medium', 'high'],
    ];

    /** @var list<string> */
    public const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

    /** @var list<string> */
    public const PERSONALITIES = ['friendly', 'pragmatic', 'none'];

    /** @var list<string> */
    public const DROPPED_FEATURE_KEYS = [
        'steer',
        'collaboration_modes',
        'elevated_windows_sandbox',
        'experimental_windows_sandbox',
        'enable_experimental_windows_sandbox',
        'remote_models',
        'request_permissions',
        'request_rule',
        'responses_websockets',
        'responses_websockets_v2',
        'search_tool',
        'sqlite',
        'use_linux_sandbox_bwrap',
        'web_search_cached',
        'web_search_request',
    ];

    /** @var list<string> */
    public const SUPPORTED_FEATURE_KEYS = [
        'apply_patch_freeform',
        'apps',
        'artifact',
        'child_agents_md',
        'claude_citations',
        'claude_pdf_support',
        'claude_tool_use',
        'code_mode',
        'code_mode_only',
        'codex_git_commit',
        'codex_hooks',
        'default_mode_request_user_input',
        'enable_fanout',
        'enable_request_compression',
        'exec_permission_approvals',
        'extended_thinking',
        'fast_mode',
        'guardian_approval',
        'image_detail_original',
        'image_generation',
        'js_repl',
        'js_repl_tools_only',
        'memories',
        'multi_agent',
        'personality',
        'plugins',
        'powershell_utf8',
        'prevent_idle_sleep',
        'prompt_caching',
        'realtime_conversation',
        'request_permissions_tool',
        'runtime_metrics',
        'shell_snapshot',
        'shell_tool',
        'shell_zsh_fork',
        'skill_env_var_dependency_prompt',
        'skill_mcp_dependency_install',
        'tool_call_mcp_elicitation',
        'tool_suggest',
        'tui_app_server',
        'undo',
        'unified_exec',
        'use_legacy_landlock',
        'voice_transcription',
    ];

    public function normalizeSettings(array $settings): array
    {
        $normalizeString = fn ($value): ?string => $this->normalizeString($value);
        $normalizeBool = fn ($value, ?bool $default = null): ?bool => $this->normalizeBool($value, $default);
        $rawModel = $settings['model'] ?? null;
        $model = self::normalizeStoredModel($rawModel);
        $forceUpgradedModel = self::isLegacyModelUpgrade($rawModel);

        $result = [
            'model' => $model,
            'model_provider' => $normalizeString($settings['model_provider'] ?? null),
            'local_provider' => $normalizeString($settings['local_provider'] ?? null),
            'profile' => $normalizeString($settings['profile'] ?? null),
            'personality' => $this->normalizePersonality($settings['personality'] ?? null) ?? 'friendly',
            'approval_policy' => $this->normalizeApprovalPolicy($settings['approval_policy'] ?? null),
            'sandbox_mode' => $normalizeString($settings['sandbox_mode'] ?? null),
            'security' => [
                'dangerously_bypass_approvals_and_sandbox' => $normalizeBool(
                    (is_array($settings['security'] ?? null) ? ($settings['security']['dangerously_bypass_approvals_and_sandbox'] ?? null) : null)
                ),
            ],
            'web_search' => $this->normalizeWebSearchFeature($settings['web_search'] ?? null),
            'model_reasoning_effort' => $forceUpgradedModel && $model !== null
                ? self::FORCE_UPGRADE_REASONING_EFFORT
                : $this->normalizeReasoningEffortForModel(
                    $settings['model_reasoning_effort'] ?? null,
                    $model
                ),
            'model_reasoning_summary' => null, // set after model-aware normalization
            'model_verbosity' => $this->normalizeModelVerbosity($settings['model_verbosity'] ?? null, $model),
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
            'model_migrations' => [
                'gpt-5.1-codex-max' => 'gpt-5.4',
                'gpt-5.1-codex-mini' => 'gpt-5.4',
                'gpt-5.2-codex' => 'gpt-5.4',
                'gpt-5.3-codex-spark' => 'gpt-5.4',
            ],
        ];
        $notice = [];
        foreach ($noticeDefaults as $key => $default) {
            $candidate = array_key_exists($key, $noticeRaw) ? $noticeRaw[$key] : $default;
            if ($key === 'model_migrations') {
                $notice[$key] = $this->normalizeStringMap(is_array($default) ? $default : []);
                continue;
            }
            $notice[$key] = $normalizeBool($candidate, $default) ?? $default;
        }
        foreach ($noticeRaw as $key => $value) {
            if ($key === 'model_migrations') {
                $defaultMigrations = is_array($notice[$key] ?? null) ? $notice[$key] : [];
                $customMigrations = $this->normalizeStringMap(is_array($value) ? $value : []);
                $notice[$key] = array_replace($defaultMigrations, $customMigrations);
                continue;
            }
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
            $name = $normalizeString((string) $key);
            if ($name === null || $name === '') {
                continue;
            }
            if ($name === 'web_search' || $name === 'web_search_request' || $name === 'web_search_cached') {
                $normalized = $this->normalizeWebSearchFeature($value);
                if ($name === 'web_search_cached' && $normalized === 'live') {
                    $normalized = 'cached';
                }
                if ($normalized !== null && $result['web_search'] === null) {
                    $result['web_search'] = $normalized;
                }
                continue;
            }
            if (in_array($name, self::DROPPED_FEATURE_KEYS, true)) {
                continue;
            }
            if (!in_array($name, self::SUPPORTED_FEATURE_KEYS, true)) {
                continue;
            }
            $boolValue = $normalizeBool($value);
            if ($boolValue === null) {
                continue;
            }
            $features[$name] = $boolValue;
        }
        foreach (['apps', 'memories', 'multi_agent'] as $defaultEnabledFeature) {
            if (!array_key_exists($defaultEnabledFeature, $features)) {
                $features[$defaultEnabledFeature] = true;
            }
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

            $profileModelRaw = $normalizeString($entry['model'] ?? null);
            $profileModel = self::normalizeStoredModel($profileModelRaw);
            $forceUpgradedProfileModel = self::isLegacyModelUpgrade($profileModelRaw);
            $profileWebSearch = $this->normalizeWebSearchFeature($entry['web_search'] ?? null);
            $profileFeaturesRaw = is_array($entry['features'] ?? null) ? $entry['features'] : [];
            $profileFeatures = [];
            foreach ($profileFeaturesRaw as $key => $value) {
                $featureName = $normalizeString((string) $key);
                if ($featureName === null || $featureName === '') {
                    continue;
                }
                if ($featureName === 'web_search' || $featureName === 'web_search_request' || $featureName === 'web_search_cached') {
                    $normalized = $this->normalizeWebSearchFeature($value);
                    if ($featureName === 'web_search_cached' && $normalized === 'live') {
                        $normalized = 'cached';
                    }
                    if ($normalized !== null && $profileWebSearch === null) {
                        $profileWebSearch = $normalized;
                    }
                    continue;
                }
                if (in_array($featureName, self::DROPPED_FEATURE_KEYS, true)) {
                    continue;
                }
                if (!in_array($featureName, self::SUPPORTED_FEATURE_KEYS, true)) {
                    continue;
                }
                $boolValue = $normalizeBool($value);
                if ($boolValue === null) {
                    continue;
                }
                $profileFeatures[$featureName] = $boolValue;
            }

            $profileSandboxRaw = is_array($entry['sandbox_workspace_write'] ?? null) ? $entry['sandbox_workspace_write'] : [];
            $profiles[] = [
                'name' => $name,
                'model' => $profileModel,
                'approval_policy' => $this->normalizeApprovalPolicy($entry['approval_policy'] ?? null),
                'sandbox_mode' => $normalizeString($entry['sandbox_mode'] ?? null),
                'personality' => $this->normalizePersonality($entry['personality'] ?? null),
                'web_search' => $profileWebSearch,
                'model_reasoning_effort' => $forceUpgradedProfileModel && $profileModel !== null
                    ? self::FORCE_UPGRADE_REASONING_EFFORT
                    : $this->normalizeReasoningEffortForModel(
                        $entry['model_reasoning_effort'] ?? null,
                        $profileModel
                    ),
                'model_reasoning_summary' => $this->normalizeReasoningSummary($entry['model_reasoning_summary'] ?? null, $profileModel),
                'model_verbosity' => $this->normalizeModelVerbosity($entry['model_verbosity'] ?? null, $profileModel),
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

    public function normalizeModelVerbosity($value, $model): ?string
    {
        $normalized = $this->normalizeString($value);
        if ($normalized === null || $normalized === '') {
            return null;
        }

        $allowed = ['low', 'medium', 'high'];
        if (!in_array($normalized, $allowed, true)) {
            return null;
        }

        $modelKey = strtolower((string) $model);
        return $normalized;
    }

    public function normalizeString(mixed $value): ?string
    {
        if (!is_string($value) && !is_numeric($value)) {
            return null;
        }
        $str = trim((string) $value);
        return $str === '' ? null : $str;
    }

    public function normalizeBool(mixed $value, ?bool $default = null): ?bool
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

    public function normalizeWebSearchFeature(mixed $value): ?string
    {
        if (is_bool($value)) {
            return $value ? 'live' : 'disabled';
        }
        if (is_int($value)) {
            return $value !== 0 ? 'live' : 'disabled';
        }
        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            if (in_array($normalized, ['live', 'cached', 'disabled'], true)) {
                return $normalized;
            }
            if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) {
                return 'live';
            }
            if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) {
                return 'disabled';
            }
        }

        return null;
    }

    public function normalizeApprovalPolicy(mixed $value): ?string
    {
        $normalized = $this->normalizeString($value);
        if ($normalized === null) {
            return null;
        }

        if (strtolower($normalized) === 'on-failure') {
            return 'on-request';
        }

        return $normalized;
    }

    public function normalizePersonality(mixed $value): ?string
    {
        $normalized = $this->normalizeString($value);
        if ($normalized === null) {
            return null;
        }

        $lower = strtolower($normalized);
        if (!in_array($lower, self::PERSONALITIES, true)) {
            return null;
        }

        return $lower;
    }

    public function normalizeReasoningSummary(mixed $value, ?string $model = null): ?string
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

        if ($model !== null && $this->isSparkCodexModel($model)) {
            // gpt-5.3-codex-spark rejects reasoning summary settings.
            return null;
        }

        if ($model !== null && $this->isDetailedOnlyCodexModel($model)) {
            // gpt-5.3-codex supports detailed summaries only.
            return 'detailed';
        }

        return $lower;
    }

    public function normalizeReasoningEffortForModel(mixed $value, ?string $model): ?string
    {
        $effort = self::normalizeReasoningEffort($value);
        if ($effort === null || $model === null) {
            return null;
        }

        return self::modelSupportsReasoningEffort($model, $effort) ? $effort : null;
    }

    public function normalizeInt(mixed $value): ?int
    {
        if (is_int($value)) {
            return $value;
        }
        if (is_string($value) && preg_match('/^-?[0-9]+$/', trim($value)) === 1) {
            return (int) $value;
        }

        return null;
    }

    public function normalizeStringList(mixed $value): array
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

    public function normalizeStringMap(mixed $value): array
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

    public function isSparkCodexModel(string $model): bool
    {
        $m = strtolower(trim($model));
        return str_contains($m, 'codex-spark');
    }

    public function isDetailedOnlyCodexModel(string $model): bool
    {
        $m = strtolower(trim($model));
        return $m === 'gpt-5.3-codex';
    }

    /** @return list<string> */
    public static function supportedModels(): array
    {
        return self::SUPPORTED_MODELS;
    }

    public static function normalizeSupportedModel(mixed $value): ?string
    {
        if (!is_string($value) && !is_numeric($value)) {
            return null;
        }
        $model = strtolower(trim((string) $value));
        if ($model === '') {
            return null;
        }

        return in_array($model, self::SUPPORTED_MODELS, true) ? $model : null;
    }

    public static function normalizeStoredModel(mixed $value): ?string
    {
        $supported = self::normalizeSupportedModel($value);
        if ($supported !== null) {
            return $supported;
        }

        if (!is_string($value) && !is_numeric($value)) {
            return null;
        }

        $model = strtolower(trim((string) $value));
        if ($model === '') {
            return null;
        }

        return self::LEGACY_MODEL_UPGRADES[$model] ?? null;
    }

    public static function isLegacyModelUpgrade(mixed $value): bool
    {
        if (!is_string($value) && !is_numeric($value)) {
            return false;
        }

        $model = strtolower(trim((string) $value));
        if ($model === '') {
            return false;
        }

        return array_key_exists($model, self::LEGACY_MODEL_UPGRADES);
    }

    public static function isClaudeModel(mixed $value): bool
    {
        if (!is_string($value) && !is_numeric($value)) {
            return false;
        }
        $model = strtolower(trim((string) $value));

        return in_array($model, self::CLAUDE_SUPPORTED_MODELS, true)
            || isset(self::CLAUDE_LEGACY_MODEL_UPGRADES[$model]);
    }

    public static function normalizeClaudeModel(mixed $value): ?string
    {
        if (!is_string($value) && !is_numeric($value)) {
            return null;
        }
        $model = strtolower(trim((string) $value));
        if ($model === '') {
            return null;
        }
        if (in_array($model, self::CLAUDE_SUPPORTED_MODELS, true)) {
            return $model;
        }

        return self::CLAUDE_LEGACY_MODEL_UPGRADES[$model] ?? null;
    }

    /** @return list<string> */
    public static function supportedReasoningEffortsForModel(mixed $model): array
    {
        $normalized = self::normalizeSupportedModel($model);
        if ($normalized !== null) {
            return self::MODEL_REASONING_EFFORTS[$normalized] ?? [];
        }

        $claudeNormalized = self::normalizeClaudeModel($model);
        if ($claudeNormalized !== null) {
            return self::CLAUDE_MODEL_REASONING_EFFORTS[$claudeNormalized] ?? [];
        }

        return [];
    }

    public static function normalizeReasoningEffort(mixed $value): ?string
    {
        if (!is_string($value) && !is_numeric($value)) {
            return null;
        }
        $effort = strtolower(trim((string) $value));
        if ($effort === '') {
            return null;
        }

        return in_array($effort, self::REASONING_EFFORTS, true) ? $effort : null;
    }

    public static function modelSupportsReasoningEffort(mixed $model, mixed $effort): bool
    {
        $normalizedEffort = self::normalizeReasoningEffort($effort);
        if ($normalizedEffort === null) {
            return false;
        }

        $efforts = self::supportedReasoningEffortsForModel($model);

        return in_array($normalizedEffort, $efforts, true);
    }

    public function settingsHash(mixed $settings): string
    {
        $normalized = $this->normalizeForHash($settings);
        $encoded = json_encode($normalized, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        return hash('sha256', $encoded === false ? '' : $encoded);
    }

    public function normalizeForHash(mixed $value): mixed
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
    public function sortedAssoc(array $map): array
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
    public function sortEntriesByName(array $entries): array
    {
        usort($entries, static function ($a, $b): int {
            $aKey = (string) ($a['name'] ?? '');
            $bKey = (string) ($b['name'] ?? '');
            return strcmp($aKey, $bKey);
        });

        return $entries;
    }

    public function isAssoc(array $value): bool
    {
        return array_keys($value) !== range(0, count($value) - 1);
    }

    public function assertSha(?string $sha, bool $allowNull = false, array &$errors = []): void
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
}
