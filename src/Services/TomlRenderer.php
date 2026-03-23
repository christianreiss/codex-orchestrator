<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

class TomlRenderer
{
    public function buildToml(array $settings): string
    {
        $lines = [];

        $rootKeys = [
            'model',
            'model_provider',
            'local_provider',
            'profile',
            'personality',
            'approval_policy',
            'sandbox_mode',
            'web_search',
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

        $features = $settings['features'] ?? [];
        if (!is_array($features)) {
            $features = [];
        }
        unset($features['web_search'], $features['web_search_request'], $features['web_search_cached']);
        foreach (ConfigNormalizer::DROPPED_FEATURE_KEYS as $obsoleteFeature) {
            unset($features[$obsoleteFeature]);
        }
        if ($this->hasAny($features)) {
            $this->addBlankLine($lines);
            $lines[] = '[features]';
            foreach ($this->sortedAssoc($features) as $key => $value) {
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

        if ($this->hasAny($settings['security'] ?? [])) {
            $this->addBlankLine($lines);
            $lines[] = '[security]';
            $security = $settings['security'] ?? [];
            $this->addKeyValue($lines, 'dangerously_bypass_approvals_and_sandbox', $security['dangerously_bypass_approvals_and_sandbox'] ?? null);
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
                $this->addKeyValue($lines, 'personality', $profile['personality'] ?? null);
                $this->addKeyValue($lines, 'web_search', $profile['web_search'] ?? null);
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

    public function escapeString(string $value): string
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

    public function tomlString(string $value): string
    {
        $escaped = str_replace(['\\', '"'], ['\\\\', '\\"'], $value);
        return '"' . $escaped . '"';
    }

    public function injectTrustedProjectToml(string $content, ?string $homePath): string
    {
        $path = $this->normalizeHomePath($homePath, null);
        if ($path === null || $path === '') {
            return $content;
        }

        $table = '[projects.' . $this->tomlString($path) . ']';
        if (strpos($content, $table) !== false) {
            return $content;
        }

        $trimmed = rtrim($content);
        $separator = $trimmed === '' ? '' : "\n\n";
        return $trimmed . $separator . $table . "\ntrust_level = \"trusted\"\n";
    }

    public function normalizeHomePath(?string $home, ?string $username): ?string
    {
        $normalized = is_string($home) ? trim($home) : null;
        if ($normalized === '') {
            $normalized = null;
        }
        if ($normalized === null) {
            $candidateUser = is_string($username) ? trim($username) : null;
            if ($candidateUser === '') {
                $candidateUser = null;
            }
            if ($candidateUser !== null && $candidateUser !== '' && preg_match('/^[A-Za-z0-9._-]+$/', $candidateUser)) {
                $normalized = '/home/' . $candidateUser;
            } else {
                return null;
            }
        }

        if (!str_starts_with($normalized, '/')) {
            return null;
        }

        if (preg_match('/[\x00-\x1F\x7F]/', $normalized)) {
            return null;
        }

        return $normalized;
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
