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
        if (!is_file($this->storagePath) && is_file($this->seedPath)) {
            @copy($this->seedPath, $this->storagePath);
            @chmod($this->storagePath, 0644);
        }

        $stored = $this->versions->get('wrapper');
        if ($stored === null) {
            $detected = $this->detectVersionFromFile($this->storagePath);
            if ($detected !== null) {
                $this->versions->set('wrapper', $detected);
            }
        }
    }

    public function metadata(): array
    {
        $version = $this->versions->get('wrapper');

        if (!is_file($this->storagePath)) {
            return [
                'version' => $version,
                'sha256' => null,
                'size_bytes' => null,
                'updated_at' => null,
                'url' => null,
            ];
        }

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
        $this->versions->set('wrapper', $normalizedVersion);

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
            return $candidate === '' ? null : $candidate;
        }

        return null;
    }
}
