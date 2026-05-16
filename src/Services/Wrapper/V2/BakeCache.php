<?php

declare(strict_types=1);

namespace App\Services\Wrapper\V2;

use RuntimeException;

/**
 * Filesystem-backed cache for baked per-host configs.
 * Layout: <cacheRoot>/<host_id>/<engine>/<config_version>/{config.json,config.json.sig,meta.json}
 *
 * A separate `current.json` pointer lives at <cacheRoot>/<host_id>/<engine>/current.json
 * so the controller can fetch the latest without scanning subdirectories.
 */
final class BakeCache
{
    public function __construct(private readonly string $cacheRoot)
    {
        if (!is_dir($cacheRoot)) {
            @mkdir($cacheRoot, 0o775, true);
        }
    }

    /**
     * @return array{config_version:int,etag:string,size_bytes:int,baked_at:string,path:string}|null
     */
    public function getCurrent(int $hostId, string $engine): ?array
    {
        $ptr = $this->pointerPath($hostId, $engine);
        if (!is_file($ptr)) {
            return null;
        }
        $raw = @file_get_contents($ptr);
        if (!is_string($raw)) {
            return null;
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded) || !isset($decoded['config_version'])) {
            return null;
        }
        $dir = $this->versionDir($hostId, $engine, (int) $decoded['config_version']);
        if (!is_dir($dir)) {
            return null;
        }
        $decoded['path'] = $dir;
        return $decoded;
    }

    public function configBody(int $hostId, string $engine, int $configVersion): ?string
    {
        $p = $this->versionDir($hostId, $engine, $configVersion) . '/config.json';
        return is_file($p) ? (file_get_contents($p) ?: null) : null;
    }

    public function signatureBody(int $hostId, string $engine, int $configVersion): ?string
    {
        $p = $this->versionDir($hostId, $engine, $configVersion) . '/config.json.sig';
        return is_file($p) ? (file_get_contents($p) ?: null) : null;
    }

    /**
     * @param array{baked_at:string,binary_version:?string,etag:string,size_bytes:int} $meta
     * @return array{config_version:int,etag:string,size_bytes:int,baked_at:string,path:string}
     */
    public function put(int $hostId, string $engine, int $configVersion, string $json, string $signatureB64, array $meta): array
    {
        $dir = $this->versionDir($hostId, $engine, $configVersion);
        if (!is_dir($dir) && !@mkdir($dir, 0o775, true) && !is_dir($dir)) {
            throw new RuntimeException("Unable to create cache dir $dir");
        }
        $this->writeAtomic($dir . '/config.json', $json);
        $this->writeAtomic($dir . '/config.json.sig', $signatureB64);

        $fullMeta = [
            'config_version' => $configVersion,
            'etag'           => $meta['etag'],
            'size_bytes'     => $meta['size_bytes'],
            'baked_at'       => $meta['baked_at'],
            'binary_version' => $meta['binary_version'] ?? null,
        ];
        $this->writeAtomic($dir . '/meta.json', json_encode($fullMeta, JSON_PRETTY_PRINT) ?: '{}');
        $this->writeAtomic($this->pointerPath($hostId, $engine), json_encode($fullMeta) ?: '{}');

        $result = $fullMeta;
        $result['path'] = $dir;
        return $result;
    }

    /** Remove cached entries older than the current pointer (best-effort GC). */
    public function prune(int $hostId, string $engine): int
    {
        $current = $this->getCurrent($hostId, $engine);
        if (!$current) {
            return 0;
        }
        $base = $this->engineDir($hostId, $engine);
        $kept = (int) $current['config_version'];
        $removed = 0;
        foreach (scandir($base) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..' || $entry === 'current.json') {
                continue;
            }
            if (!ctype_digit($entry)) {
                continue;
            }
            if ((int) $entry < $kept) {
                $removed += $this->rmTree($base . '/' . $entry);
            }
        }
        return $removed;
    }

    private function writeAtomic(string $path, string $body): void
    {
        $tmp = $path . '.new';
        if (file_put_contents($tmp, $body) === false) {
            throw new RuntimeException("Failed to write $tmp");
        }
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException("Failed to rename $tmp to $path");
        }
    }

    private function pointerPath(int $hostId, string $engine): string
    {
        return $this->engineDir($hostId, $engine) . '/current.json';
    }

    private function engineDir(int $hostId, string $engine): string
    {
        return $this->cacheRoot . "/$hostId/$engine";
    }

    private function versionDir(int $hostId, string $engine, int $configVersion): string
    {
        return $this->engineDir($hostId, $engine) . "/$configVersion";
    }

    private function rmTree(string $path): int
    {
        $count = 0;
        if (is_dir($path)) {
            foreach (scandir($path) ?: [] as $entry) {
                if ($entry === '.' || $entry === '..') {
                    continue;
                }
                $count += $this->rmTree($path . '/' . $entry);
            }
            @rmdir($path);
        } else {
            if (@unlink($path)) {
                $count = 1;
            }
        }
        return $count;
    }
}
