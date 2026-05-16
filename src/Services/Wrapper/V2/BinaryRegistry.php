<?php

declare(strict_types=1);

namespace App\Services\Wrapper\V2;

/**
 * BinaryRegistry discovers what wrapper binaries are published in
 * storage/wrapper/v2/bin/<engine>/<os>-<arch>/v<version>/<binary>, computes
 * SHA256, and reports the latest version available per platform.
 *
 * It's a read-only view over the filesystem; CI publishes new builds by
 * writing into the directory tree. The orchestrator never produces binaries
 * at request time.
 */
final class BinaryRegistry
{
    public function __construct(private readonly string $binRoot)
    {
    }

    /** Return the absolute path to a published binary, or null if absent. */
    public function path(string $engine, string $os, string $arch, string $version): ?string
    {
        $v = ltrim($version, 'v');
        $p = $this->binRoot . "/$engine/$os-$arch/v$v/$engine";
        return is_file($p) ? $p : null;
    }

    /**
     * Return the latest available version for an engine/platform.
     * Versions are compared with version_compare (semver-friendly).
     */
    public function latestVersion(string $engine, string $os, string $arch): ?string
    {
        $dir = $this->binRoot . "/$engine/$os-$arch";
        if (!is_dir($dir)) {
            return null;
        }
        $versions = [];
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            if (preg_match('/^v(.+)$/', $entry, $m) && is_file("$dir/$entry/$engine")) {
                $versions[] = $m[1];
            }
        }
        if (!$versions) {
            return null;
        }
        usort($versions, 'version_compare');
        return end($versions);
    }

    /**
     * @return array{
     *   engine: string,
     *   platforms: array<string, array{version: string, sha256: string, size_bytes: int, url_path: string}>
     * }
     */
    public function manifest(string $engine, string $publicBaseUrl): array
    {
        $platforms = [];
        $root = $this->binRoot . "/$engine";
        if (is_dir($root)) {
            foreach (scandir($root) ?: [] as $platform) {
                if ($platform === '.' || $platform === '..' || !preg_match('/^[a-z0-9]+-[a-z0-9]+$/', $platform)) {
                    continue;
                }
                [$os, $arch] = explode('-', $platform, 2);
                $version = $this->latestVersion($engine, $os, $arch);
                if ($version === null) {
                    continue;
                }
                $bin = $this->path($engine, $os, $arch, $version);
                if ($bin === null) {
                    continue;
                }
                $sha = hash_file('sha256', $bin) ?: '';
                $size = filesize($bin) ?: 0;
                $platforms[$platform] = [
                    'version'    => $version,
                    'sha256'     => $sha,
                    'size_bytes' => $size,
                    'url_path'   => rtrim($publicBaseUrl, '/') . "/wrapper/v2/bin/$engine/$platform/v$version/$engine",
                ];
            }
        }
        return ['engine' => $engine, 'platforms' => $platforms];
    }

    public function sha256(string $engine, string $os, string $arch, string $version): ?string
    {
        $p = $this->path($engine, $os, $arch, $version);
        if ($p === null) {
            return null;
        }
        return hash_file('sha256', $p) ?: null;
    }

    public function binRoot(): string
    {
        return $this->binRoot;
    }
}
