<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Repositories\VersionRepository;
use App\Security\SecretBox;

class WrapperService
{
    private bool $seedFallbackWarned = false;

    public function __construct(
        private readonly VersionRepository $versions,
        private readonly string $storagePath,
        private readonly string $seedPath,
        private readonly ?string $installationId = null,
        private readonly ?SecretBox $secretBox = null
    ) {
        $directory = dirname($this->storagePath);
        if (!is_dir($directory)) {
            mkdir($directory, 0775, true);
        }
    }

    public function ensureSeeded(): void
    {
        $resolved = $this->resolveTemplatePath();
        if ($resolved === null) {
            return;
        }

        $version = $this->versions->get('wrapper');
        $detected = $this->computeVersionForPath($resolved);
        if ($version === null || !hash_equals($version, $detected)) {
            $this->versions->set('wrapper', $detected);
        }
    }

    public function metadata(): array
    {
        $templatePath = $this->resolveTemplatePath();
        if ($templatePath === null || !is_file($templatePath)) {
            return [
                'version' => null,
                'sha256' => null,
                'size_bytes' => null,
                'updated_at' => null,
                'url' => null,
            ];
        }

        $version = $this->computeVersionForPath($templatePath);
        $this->versions->set('wrapper', $version);

        $sha = hash_file('sha256', $templatePath) ?: null;
        $size = filesize($templatePath) ?: null;
        $mtime = filemtime($templatePath);
        $updatedAt = $mtime !== false ? gmdate(DATE_ATOM, $mtime) : null;

        return [
            'version' => $version,
            'sha256' => $sha,
            'size_bytes' => $size,
            'updated_at' => $updatedAt,
            'url' => '/wrapper/download',
        ];
    }

    /**
     * Render the stored wrapper template for a specific host.
     *
     * @param array $host Must contain api_key and fqdn.
     * @param string $baseUrl Public base URL used by the host (no trailing slash).
     * @param string|null $caFile Optional CA file path to bake into the script.
     *
     * @return array{version: ?string, sha256: ?string, size_bytes: ?int, updated_at: ?string, url: ?string, content: ?string}
     */
    public function bakedForHost(array $host, string $baseUrl, ?string $caFile = null): array
    {
        $templatePath = $this->resolveTemplatePath();
        $meta = $this->metadata();
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
        $forceIpv4 = isset($host['force_ipv4']) ? (bool) (int) $host['force_ipv4'] : false;
        $curlInsecure = isset($host['curl_insecure']) ? (bool) (int) $host['curl_insecure'] : false;
        $cdxSilent = $this->versions->getFlag('cdx_silent', false);
        $escapeBashDefault = static function (string $value): string {
            $value = str_replace(["\r", "\n"], '', $value);
            return str_replace(['\\', '"', '$', '`'], ['\\\\', '\\"', '\\$', '\\`'], $value);
        };

        $modelOverride = trim((string) ($host['model_override'] ?? ''));
        $reasoningOverride = trim((string) ($host['reasoning_effort_override'] ?? ''));

        $replacements = [
            '__CODEX_SYNC_BASE_URL__' => rtrim($baseUrl, '/'),
            '__CODEX_SYNC_API_KEY__' => $apiKey,
            '__CODEX_SYNC_FQDN__' => $fqdn,
            '__CODEX_SYNC_CA_FILE__' => (string) ($caFile ?? ''),
            '__CODEX_HOST_SECURE__' => $secure ? '1' : '0',
            '__CODEX_FORCE_IPV4__' => $forceIpv4 ? '1' : '0',
            '__CODEX_INSTALLATION_ID__' => (string) ($this->installationId ?? ''),
            '__WRAPPER_VERSION__' => (string) ($meta['version'] ?? ''),
            '__CODEX_SILENT__' => $cdxSilent ? '1' : '0',
            '__CODEX_SYNC_ALLOW_INSECURE__' => $curlInsecure ? '1' : '0',
        ];
        if ($modelOverride !== '') {
            $replacements['__CODEX_HOST_MODEL__'] = $escapeBashDefault($modelOverride);
        }
        if ($reasoningOverride !== '') {
            $replacements['__CODEX_HOST_REASONING_EFFORT__'] = $escapeBashDefault($reasoningOverride);
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
            if ($candidate === '' || str_starts_with($candidate, '__')) {
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

    private function resolveTemplatePath(): ?string
    {
        $hasStorage = is_file($this->storagePath);
        $hasSeed = is_file($this->seedPath);

        if (!$hasStorage && !$hasSeed) {
            return null;
        }
        if (!$hasSeed) {
            return $hasStorage ? $this->storagePath : null;
        }
        if (!$hasStorage) {
            return $this->seedPath;
        }

        $seedHash = hash_file('sha256', $this->seedPath) ?: null;
        $storedHash = hash_file('sha256', $this->storagePath) ?: null;
        if ($seedHash !== null && $storedHash !== null && hash_equals($seedHash, $storedHash)) {
            return $this->storagePath;
        }

        if ($this->copySeedToStorage()) {
            return $this->storagePath;
        }

        $this->warnSeedFallback();
        return $this->seedPath;
    }

    private function copySeedToStorage(): bool
    {
        if (!is_file($this->seedPath)) {
            return false;
        }

        $directory = dirname($this->storagePath);
        if (!is_dir($directory) && !@mkdir($directory, 0775, true) && !is_dir($directory)) {
            return false;
        }

        if (!@copy($this->seedPath, $this->storagePath)) {
            return false;
        }

        @chmod($this->storagePath, 0644);
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
