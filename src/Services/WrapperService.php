<?php

declare(strict_types=1);

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Repositories\VersionRepository;
use App\Security\SecretBox;
use App\Services\Wrapper\V2\BinaryRegistry;
use App\Support\AdminTheme;
use App\Support\Engine;

/**
 * Dual-mode wrapper service.
 *
 * When a BinaryRegistry is injected (production path after v2 cutover) the
 * service delegates to the v2 registry for metadata/download URLs and returns
 * null content from bakedForHost (the bootstrap shim is host-agnostic).
 *
 * When no registry is present (legacy path / tests) the service falls back to
 * the v1 file-based bash-template baking so that existing callers and the test
 * suite continue to work without modification.
 */
class WrapperService
{
    private ?BinaryRegistry $registry = null;

    private bool $seedFallbackWarned = false;

    /** @var array<string,string> Storage paths per engine */
    private array $engineStoragePaths;

    /** @var array<string,string> Seed paths per engine */
    private array $engineSeedPaths;

    public function __construct(
        private readonly VersionRepository $versions,
        private string $storagePath,
        private string $seedPath,
        private readonly ?string $installationId = null,
        private readonly ?SecretBox $secretBox = null,
        ?string $clxStoragePath = null,
        ?string $clxSeedPath = null,
        ?BinaryRegistry $registry = null,
    ) {
        $this->registry = $registry;

        // Engine-specific paths (v1 file-based path).
        $this->engineStoragePaths = [
            Engine::CODEX  => $this->storagePath,
            Engine::CLAUDE => $clxStoragePath ?? str_replace('/cdx', '/clx', $this->storagePath),
        ];
        $this->engineSeedPaths = [
            Engine::CODEX  => $this->seedPath,
            Engine::CLAUDE => $clxSeedPath ?? str_replace('/cdx', '/clx', $this->seedPath),
        ];

        if ($this->registry === null) {
            $directory = dirname($this->storagePath);
            if (!is_dir($directory)) {
                @mkdir($directory, 0775, true);
            }
            foreach ($this->engineStoragePaths as $path) {
                $dir = dirname($path);
                if (!is_dir($dir)) {
                    @mkdir($dir, 0775, true);
                }
            }
        }
    }

    /** Inject (or replace) the v2 binary registry — used during request bootstrap. */
    public function setRegistry(BinaryRegistry $registry): void
    {
        $this->registry = $registry;
    }

    public function ensureSeeded(string $engine = Engine::CODEX): void
    {
        if ($this->registry !== null) {
            // v2: warm the version-key cache from the registry.
            $meta = $this->metadata($engine);
            if (is_string($meta['version'])) {
                $key = $engine === Engine::CLAUDE ? 'wrapper_claude' : 'wrapper';
                $this->versions->set($key, $meta['version']);
            }
            return;
        }

        // v1: resolve template and cache version.
        $resolved = $this->resolveTemplatePath($engine);
        if ($resolved === null) {
            return;
        }

        $versionKey = $engine === Engine::CLAUDE ? 'wrapper_claude' : 'wrapper';
        $version = $this->versions->get($versionKey);
        $detected = $this->computeVersionForPath($resolved);
        if ($version === null || !hash_equals($version, $detected)) {
            $this->versions->set($versionKey, $detected);
        }
    }

    public function ensureAllSeeded(): void
    {
        foreach (Engine::ALL as $engine) {
            $this->ensureSeeded($engine);
        }
    }

    /**
     * @return array{engine:string,version:?string,sha256:?string,size_bytes:?int,updated_at:?string,url:?string}
     */
    public function metadata(string $engine = Engine::CODEX): array
    {
        $engine = Engine::isValid($engine) ? $engine : Engine::CODEX;

        if ($this->registry !== null) {
            // v2 path.
            $version = $this->registry->latestVersion($engine, 'linux', 'amd64');
            if ($version === null) {
                return [
                    'engine'     => $engine,
                    'version'    => null,
                    'sha256'     => null,
                    'size_bytes' => null,
                    'updated_at' => null,
                    'url'        => null,
                ];
            }
            $path = $this->registry->path($engine, 'linux', 'amd64', $version);
            $sha = $path !== null ? (hash_file('sha256', $path) ?: null) : null;
            $size = $path !== null ? (filesize($path) ?: null) : null;
            $mtime = $path !== null ? filemtime($path) : false;
            $updatedAt = $mtime !== false ? gmdate(DATE_ATOM, $mtime) : null;

            return [
                'engine'     => $engine,
                'version'    => $version,
                'sha256'     => $sha,
                'size_bytes' => $size,
                'updated_at' => $updatedAt,
                'url'        => '/wrapper/v2/download?engine=' . $engine,
            ];
        }

        // v1 file-based path.
        $templatePath = $this->resolveTemplatePath($engine);
        if ($templatePath === null || !is_file($templatePath)) {
            return [
                'engine'     => $engine,
                'version'    => null,
                'sha256'     => null,
                'size_bytes' => null,
                'updated_at' => null,
                'url'        => null,
            ];
        }

        $versionKey = $engine === Engine::CLAUDE ? 'wrapper_claude' : 'wrapper';
        $version = $this->computeVersionForPath($templatePath);
        $this->versions->set($versionKey, $version);

        $sha = hash_file('sha256', $templatePath) ?: null;
        $size = filesize($templatePath) ?: null;
        $mtime = filemtime($templatePath);
        $updatedAt = $mtime !== false ? gmdate(DATE_ATOM, $mtime) : null;

        return [
            'engine'     => $engine,
            'version'    => $version,
            'sha256'     => $sha,
            'size_bytes' => $size,
            'updated_at' => $updatedAt,
            'url'        => '/wrapper/download?engine=' . $engine,
        ];
    }

    /**
     * v2 has no per-host baked wrapper content — the bootstrap shim is host-
     * agnostic at this level (the host's API key is fetched via the v2 config
     * endpoint, not embedded in the shim). When a registry is present the
     * `content` field is null and callers must use `/wrapper/v2/download`.
     *
     * When no registry is present (v1 / legacy) the template file is rendered
     * with per-host substitutions as before.
     *
     * @param array<string,mixed> $host
     * @return array{engine:string,version:?string,sha256:?string,size_bytes:?int,updated_at:?string,url:?string,content:?string}
     */
    public function bakedForHost(array $host, string $baseUrl, ?string $caFile = null, string $engine = Engine::CODEX): array
    {
        if ($this->registry !== null) {
            unset($host, $baseUrl, $caFile);
            return array_merge($this->metadata($engine), ['content' => null]);
        }

        // v1 file-based baking.
        $templatePath = $this->resolveTemplatePath($engine);
        $meta = $this->metadata($engine);
        if ($templatePath === null || !is_file($templatePath)) {
            return array_merge($meta, ['content' => null]);
        }

        $template = file_get_contents($templatePath);
        if ($template === false) {
            return array_merge($meta, ['content' => null]);
        }

        // hosts.api_key stores a hash for lookup/back-compat; the baked wrapper needs the plaintext key.
        $apiKey = (string) ($host['api_key_plain'] ?? '');
        if ($apiKey === '' && $this->secretBox !== null && isset($host['api_key_enc'])) {
            $apiKey = $this->secretBox->decrypt((string) $host['api_key_enc']);
        }
        $fqdn = (string) ($host['fqdn'] ?? '');
        $secure = isset($host['secure']) ? (bool) (int) $host['secure'] : true;
        $curlInsecure = isset($host['curl_insecure']) ? (bool) (int) $host['curl_insecure'] : false;
        $adminTheme = AdminTheme::normalize($this->versions->get('admin_theme'));
        $escapeBashDoubleQuoted = static function (string $value): string {
            $value = str_replace(["\r", "\n"], '', $value);
            return str_replace(['\\', '"', '$', '`'], ['\\\\', '\\"', '\\$', '\\`'], $value);
        };

        if ($engine === Engine::CLAUDE) {
            $claudeModel = trim((string) ($host['claude_model_override'] ?? ''));
            $silentFlag = $this->versions->getFlag('clx_silent', false) || $this->versions->getFlag('cdx_silent', false);

            $replacements = [
                '__CLAUDE_SYNC_BASE_URL__'      => $escapeBashDoubleQuoted(rtrim($baseUrl, '/')),
                '__CLAUDE_SYNC_API_KEY__'        => $escapeBashDoubleQuoted($apiKey),
                '__CLAUDE_SYNC_FQDN__'           => $escapeBashDoubleQuoted($fqdn),
                '__CLAUDE_SYNC_CA_FILE__'        => $escapeBashDoubleQuoted((string) ($caFile ?? '')),
                '__CLAUDE_HOST_SECURE__'         => $secure ? '1' : '0',
                '__CLAUDE_INSTALLATION_ID__'     => (string) ($this->installationId ?? ''),
                '__WRAPPER_VERSION__'            => (string) ($meta['version'] ?? ''),
                '__CLAUDE_SILENT__'              => $silentFlag ? '1' : '0',
                '__CLAUDE_SYNC_ALLOW_INSECURE__' => $curlInsecure ? '1' : '0',
            ];
            if ($claudeModel !== '') {
                $replacements['__CLAUDE_HOST_MODEL__'] = $escapeBashDoubleQuoted($claudeModel);
            }
        } else {
            $cdxSilent = $this->versions->getFlag('cdx_silent', false);
            $rawModelOverride = $host['model_override'] ?? null;
            $modelOverride = ConfigNormalizer::normalizeStoredModel($rawModelOverride) ?? '';
            $reasoningOverride = trim((string) ($host['reasoning_effort_override'] ?? ''));
            if (ConfigNormalizer::isLegacyModelUpgrade($rawModelOverride) && $modelOverride !== '') {
                $reasoningOverride = ConfigNormalizer::FORCE_UPGRADE_REASONING_EFFORT;
            }

            $replacements = [
                '__CODEX_SYNC_BASE_URL__'      => $escapeBashDoubleQuoted(rtrim($baseUrl, '/')),
                '__CODEX_SYNC_API_KEY__'        => $escapeBashDoubleQuoted($apiKey),
                '__CODEX_SYNC_FQDN__'           => $escapeBashDoubleQuoted($fqdn),
                '__CODEX_SYNC_CA_FILE__'        => $escapeBashDoubleQuoted((string) ($caFile ?? '')),
                '__CODEX_HOST_SECURE__'         => $secure ? '1' : '0',
                '__CODEX_INSTALLATION_ID__'     => (string) ($this->installationId ?? ''),
                '__WRAPPER_VERSION__'           => (string) ($meta['version'] ?? ''),
                '__CODEX_SILENT__'              => $cdxSilent ? '1' : '0',
                '__CODEX_ADMIN_THEME__'         => $adminTheme,
                '__CODEX_SYNC_ALLOW_INSECURE__' => $curlInsecure ? '1' : '0',
            ];
            if ($modelOverride !== '') {
                $replacements['__CODEX_HOST_MODEL__'] = $escapeBashDoubleQuoted($modelOverride);
            }
            if ($reasoningOverride !== '') {
                $replacements['__CODEX_HOST_REASONING_EFFORT__'] = $escapeBashDoubleQuoted($reasoningOverride);
            }
        }

        $rendered = strtr($template, $replacements);
        $sha = hash('sha256', $rendered) ?: null;

        $meta['sha256'] = $sha;
        $meta['size_bytes'] = strlen($rendered);
        $meta['content'] = $rendered;

        return $meta;
    }

    private function detectVersionFromFile(string $path): ?string
    {
        if (!is_file($path)) {
            return null;
        }

        $content = file_get_contents($path);
        if ($content === false) {
            return null;
        }

        if (preg_match('/WRAPPER_VERSION="([^"]+)"/', $content, $matches)) {
            $candidate = trim($matches[1]);
            if ($candidate === '' || str_contains($candidate, '__WRAPPER_VERSION__') || str_starts_with($candidate, '${')) {
                return null;
            }
            return $candidate;
        }

        return null;
    }

    private function computeVersionForPath(string $path): string
    {
        $detected = $this->detectVersionFromFile($path);
        if ($detected !== null) {
            return $detected;
        }

        $hash = hash_file('sha256', $path) ?: bin2hex(random_bytes(6));
        return 'auto-' . substr($hash, 0, 12);
    }

    private function resolveTemplatePath(string $engine = Engine::CODEX): ?string
    {
        $storagePath = $this->engineStoragePaths[$engine] ?? $this->storagePath;
        $seedPath = $this->engineSeedPaths[$engine] ?? $this->seedPath;

        $hasStorage = is_file($storagePath);
        $hasSeed = is_file($seedPath);

        if (!$hasStorage && !$hasSeed) {
            return null;
        }
        if (!$hasSeed) {
            return $hasStorage ? $storagePath : null;
        }
        if (!$hasStorage) {
            return $seedPath;
        }

        $seedHash = hash_file('sha256', $seedPath) ?: null;
        $storedHash = hash_file('sha256', $storagePath) ?: null;
        if ($seedHash !== null && $storedHash !== null && hash_equals($seedHash, $storedHash)) {
            return $storagePath;
        }

        if ($this->copySeedToStorage($engine)) {
            return $storagePath;
        }

        $this->warnSeedFallback();
        return $seedPath;
    }

    private function copySeedToStorage(string $engine = Engine::CODEX): bool
    {
        $seedPath = $this->engineSeedPaths[$engine] ?? $this->seedPath;
        $storagePath = $this->engineStoragePaths[$engine] ?? $this->storagePath;

        if (!is_file($seedPath)) {
            return false;
        }

        $directory = dirname($storagePath);
        if (!is_dir($directory) && !@mkdir($directory, 0775, true) && !is_dir($directory)) {
            return false;
        }

        if (!@copy($seedPath, $storagePath)) {
            return false;
        }

        @chmod($storagePath, 0644);
        return true;
    }

    private function warnSeedFallback(): void
    {
        if ($this->seedFallbackWarned) {
            return;
        }
        $this->seedFallbackWarned = true;

        $now = time();
        $lastWarnRaw = $this->versions->get('wrapper_seed_fallback_last_warn');
        $lastWarn = ($lastWarnRaw !== null && ctype_digit($lastWarnRaw)) ? (int) $lastWarnRaw : null;
        if ($lastWarn !== null && ($now - $lastWarn) < 300) {
            return;
        }
        $this->versions->set('wrapper_seed_fallback_last_warn', (string) $now);

        $storageDir = dirname($this->storagePath);
        error_log(sprintf(
            '[wrapper] seed/storage mismatch; copy failed, serving seed wrapper directly (seed=%s storage=%s storage_writable=%s storage_dir_writable=%s)',
            $this->seedPath,
            $this->storagePath,
            is_writable($this->storagePath) ? 'yes' : 'no',
            is_writable($storageDir) ? 'yes' : 'no'
        ));
    }
}
