<?php

namespace App\Services;

use App\Repositories\VersionRepository;
use RuntimeException;

class WrapperService
{
    public function __construct(
        private readonly VersionRepository $versions,
        private readonly string $storagePath,
        private readonly string $seedPath
    ) {
        $directory = dirname($this->storagePath);
        if (!is_dir($directory)) {
            mkdir($directory, 0775, true);
        }
    }

    public function ensureSeeded(): void
    {
        if (!is_file($this->seedPath)) {
            return;
        }

        $needsCopy = !is_file($this->storagePath);
        if (!$needsCopy) {
            $seedHash = hash_file('sha256', $this->seedPath) ?: null;
            $storedHash = hash_file('sha256', $this->storagePath) ?: null;
            $needsCopy = $seedHash !== null && $storedHash !== null && !hash_equals($seedHash, $storedHash);
        }

        if ($needsCopy) {
            @copy($this->seedPath, $this->storagePath);
            @chmod($this->storagePath, 0644);
        }

        $version = $this->versions->get('wrapper');
        if ($version === null || $needsCopy) {
            $detected = $this->computeVersionForPath($this->storagePath);
            $this->versions->set('wrapper', $detected);
        }
    }

    public function metadata(): array
    {
        if (!is_file($this->storagePath)) {
            return [
                'version' => null,
                'sha256' => null,
                'size_bytes' => null,
                'updated_at' => null,
                'url' => null,
            ];
        }

        $version = $this->computeVersionForPath($this->storagePath);
        $this->versions->set('wrapper', $version);

        $sha = hash_file('sha256', $this->storagePath) ?: null;
        $size = filesize($this->storagePath) ?: null;
        $mtime = filemtime($this->storagePath);
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
        $meta = $this->metadata();
        if (!is_file($this->storagePath)) {
            return array_merge($meta, ['content' => null]);
        }

        $template = file_get_contents($this->storagePath);
        if ($template === false) {
            return array_merge($meta, ['content' => null]);
        }

        $apiKey = (string) ($host['api_key'] ?? '');
        $fqdn = (string) ($host['fqdn'] ?? '');
        $replacements = [
            '__CODEX_SYNC_BASE_URL__' => rtrim($baseUrl, '/'),
            '__CODEX_SYNC_API_KEY__' => $apiKey,
            '__CODEX_SYNC_FQDN__' => $fqdn,
            '__CODEX_SYNC_CA_FILE__' => (string) ($caFile ?? ''),
            '__WRAPPER_VERSION__' => (string) ($meta['version'] ?? ''),
        ];

        $rendered = strtr($template, $replacements);
        $sha = hash('sha256', $rendered) ?: null;

        $meta['sha256'] = $sha;
        $meta['size_bytes'] = strlen($rendered);
        $meta['content'] = $rendered;

        return $meta;
    }

    public function replaceFromUpload(string $tmpPath, string $version, ?string $expectedSha, bool $isUploadedFile = false): array
    {
        if (!is_file($tmpPath)) {
            throw new RuntimeException('Uploaded file not found');
        }

        $normalizedVersion = trim($version);
        if ($normalizedVersion === '') {
            throw new RuntimeException('version is required');
        }

        $sha = hash_file('sha256', $tmpPath) ?: null;
        if ($expectedSha !== null) {
            $expected = strtolower(trim($expectedSha));
            if ($sha === null || !hash_equals($expected, strtolower((string) $sha))) {
                throw new RuntimeException('sha256 mismatch for uploaded file');
            }
        }

        $targetDir = dirname($this->storagePath);
        if (!is_dir($targetDir)) {
            mkdir($targetDir, 0775, true);
        }

        $moved = false;
        if ($isUploadedFile && function_exists('move_uploaded_file')) {
            $moved = move_uploaded_file($tmpPath, $this->storagePath);
        }

        if (!$moved) {
            $moved = @rename($tmpPath, $this->storagePath);
        }

        if (!$moved) {
            if (!@copy($tmpPath, $this->storagePath)) {
                throw new RuntimeException('Unable to store uploaded wrapper');
            }
        }

        @chmod($this->storagePath, 0644);
        // Version is derived from the stored wrapper content (container source of truth).
        $detected = $this->computeVersionForPath($this->storagePath);
        $this->versions->set('wrapper', $detected);

        return $this->metadata();
    }

    public function contentPath(): string
    {
        return $this->storagePath;
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
}
