<?php

declare(strict_types=1);

namespace App\Mcp;

use App\Services\SkillService;
use InvalidArgumentException;

class McpFileOperations
{
    private readonly ?string $root;
    private readonly ?SkillService $skills;

    public function __construct(?string $root = null, ?SkillService $skills = null)
    {
        $this->root = $root;
        $this->skills = $skills;
    }

    /**
     * Read a file within the allowed root and return its text content + metadata.
     *
     * @param array{path?:mixed} $args
     * @return array<string,mixed>
     */
    public function readFile(array $args): array
    {
        $pathRaw = $args['path'] ?? null;
        if (!is_string($pathRaw)) {
            throw new InvalidArgumentException('path is required');
        }

        $root = $this->root ?? dirname(__DIR__, 2);
        $path = trim($pathRaw);
        if ($path === '') {
            throw new InvalidArgumentException('path is required');
        }

        // Treat synced SKILL.md paths as compatibility aliases for the canonical DB-backed skill resource.
        $skillSlug = $this->extractSkillSlugFromPath($path);
        if ($skillSlug !== null && $this->skills !== null) {
            $skill = $this->skills->find($skillSlug);
            if ($skill !== null) {
                $manifest = (string) ($skill['manifest'] ?? '');

                return [
                    'path' => 'skill://' . $skillSlug,
                    'size_bytes' => strlen($manifest),
                    'modified_at' => $skill['updated_at'] ?? null,
                    'mimeType' => 'text/markdown',
                    'content' => $manifest,
                ];
            }
        }

        // Resolve path against root and block traversal outside it.
        $candidate = str_starts_with($path, '/') ? $path : $root . '/' . $path;
        $real = realpath($candidate);
        if ($real === false) {
            throw new InvalidArgumentException('file not found');
        }

        $realRoot = realpath($root) ?: $root;
        if ($real !== $realRoot && !str_starts_with($real, rtrim($realRoot, '/') . '/')) {
            throw new InvalidArgumentException('path is outside allowed root');
        }

        if (!is_file($real) || !is_readable($real)) {
            throw new InvalidArgumentException('file not readable');
        }

        $contents = file_get_contents($real);
        if ($contents === false) {
            throw new InvalidArgumentException('failed to read file');
        }

        $stat = stat($real);
        $size = $stat['size'] ?? strlen($contents);
        $mtime = isset($stat['mtime']) ? gmdate(DATE_ATOM, (int) $stat['mtime']) : null;

        return [
            'path' => $this->relativePath($realRoot, $real),
            'size_bytes' => $size,
            'modified_at' => $mtime,
            'mimeType' => 'text/plain',
            'content' => $contents,
        ];
    }

    /**
     * Write a text file respecting root and overwrite flags.
     *
     * @param array{path?:mixed,content?:mixed,create_if_missing?:mixed,overwrite?:mixed} $args
     * @return array<string,mixed>
     */
    public function writeFile(array $args): array
    {
        $pathRaw = $args['path'] ?? null;
        $content = $args['content'] ?? null;
        if (!is_string($pathRaw) || trim($pathRaw) === '') {
            throw new InvalidArgumentException('path is required');
        }
        if (!is_string($content)) {
            throw new InvalidArgumentException('content is required');
        }

        $create = array_key_exists('create_if_missing', $args) ? (bool) $args['create_if_missing'] : true;
        $overwrite = array_key_exists('overwrite', $args) ? (bool) $args['overwrite'] : true;

        $root = $this->root ?? dirname(__DIR__, 2);
        $realRoot = realpath($root) ?: $root;

        $candidate = str_starts_with($pathRaw, '/') ? $pathRaw : $realRoot . '/' . $pathRaw;
        $dir = dirname($candidate);
        $dirReal = realpath($dir);
        if ($dirReal === false) {
            throw new InvalidArgumentException('directory not found');
        }

        if ($dirReal !== $realRoot && !str_starts_with($dirReal, rtrim($realRoot, '/') . '/')) {
            throw new InvalidArgumentException('path is outside allowed root');
        }

        $target = $dirReal . '/' . basename($candidate);
        $exists = file_exists($target);
        if ($exists && !$overwrite) {
            throw new InvalidArgumentException('file exists and overwrite is false');
        }
        if (!$exists && !$create) {
            throw new InvalidArgumentException('file missing and create_if_missing is false');
        }

        $bytes = file_put_contents($target, $content, LOCK_EX);
        if ($bytes === false) {
            throw new InvalidArgumentException('failed to write file');
        }

        $stat = stat($target);
        $size = $stat['size'] ?? strlen($content);
        $mtime = isset($stat['mtime']) ? gmdate(DATE_ATOM, (int) $stat['mtime']) : null;

        return [
            'path' => $this->relativePath($realRoot, $target),
            'size_bytes' => $size,
            'modified_at' => $mtime,
            'written_bytes' => $bytes,
        ];
    }

    /**
     * List directory entries with optional glob filter.
     *
     * @param array{path?:mixed,glob?:mixed} $args
     * @return array<string,mixed>
     */
    public function listDir(array $args): array
    {
        $pathRaw = $args['path'] ?? null;
        $glob = isset($args['glob']) && is_string($args['glob']) ? $args['glob'] : null;
        if (!is_string($pathRaw) || trim($pathRaw) === '') {
            throw new InvalidArgumentException('path is required');
        }

        // Virtual directory listing for skill directories.
        if ($this->isSkillsDirectory($pathRaw) && $this->skills !== null) {
            $entries = [];
            foreach ($this->skills->listSkills() as $skill) {
                $slug = (string) ($skill['slug'] ?? '');
                if ($slug === '') {
                    continue;
                }
                if ($glob !== null && !fnmatch($glob, $slug, FNM_PATHNAME)) {
                    continue;
                }
                $entries[] = [
                    'name' => $slug,
                    'path' => 'skill://' . $slug,
                    'type' => 'dir',
                    'size_bytes' => null,
                    'modified_at' => $skill['updated_at'] ?? null,
                ];
            }

            return ['entries' => $entries];
        }

        $root = $this->root ?? dirname(__DIR__, 2);
        $realRoot = realpath($root) ?: $root;
        $candidate = str_starts_with($pathRaw, '/') ? $pathRaw : $realRoot . '/' . $pathRaw;
        $dirReal = realpath($candidate);
        if ($dirReal === false || !is_dir($dirReal)) {
            throw new InvalidArgumentException('directory not found');
        }
        if ($dirReal !== $realRoot && !str_starts_with($dirReal, rtrim($realRoot, '/') . '/')) {
            throw new InvalidArgumentException('path is outside allowed root');
        }

        $entries = [];
        $iterator = scandir($dirReal);
        if ($iterator === false) {
            throw new InvalidArgumentException('failed to read directory');
        }

        foreach ($iterator as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            if ($glob !== null && !fnmatch($glob, $entry, FNM_PATHNAME)) {
                continue;
            }

            $full = $dirReal . '/' . $entry;
            $stat = @stat($full);
            $mtime = isset($stat['mtime']) ? gmdate(DATE_ATOM, (int) $stat['mtime']) : null;
            $size = $stat['size'] ?? null;

            $entries[] = [
                'name' => $entry,
                'path' => $this->relativePath($realRoot, $full),
                'type' => is_dir($full) ? 'dir' : 'file',
                'size_bytes' => is_dir($full) ? null : $size,
                'modified_at' => $mtime,
            ];
        }

        return ['entries' => $entries];
    }

    /**
     * Stat a path under root; when requireExisting=false returns exists=false for missing.
     *
     * @param array{path?:mixed} $args
     * @return array<string,mixed>
     */
    public function statPath(array $args, bool $requireExisting): array
    {
        $pathRaw = $args['path'] ?? null;
        if (!is_string($pathRaw) || trim($pathRaw) === '') {
            throw new InvalidArgumentException('path is required');
        }

        // Treat synced SKILL.md paths as compatibility aliases for the canonical DB-backed skill resource.
        $skillSlug = $this->extractSkillSlugFromPath($pathRaw);
        if ($skillSlug !== null && $this->skills !== null) {
            $skill = $this->skills->find($skillSlug);
            if ($skill !== null) {
                $manifest = (string) ($skill['manifest'] ?? '');

                return [
                    'exists' => true,
                    'path' => 'skill://' . $skillSlug,
                    'type' => 'file',
                    'size_bytes' => strlen($manifest),
                    'modified_at' => $skill['updated_at'] ?? null,
                ];
            }
        }

        // Intercept skill directory listings.
        if ($this->isSkillsDirectory($pathRaw) && $this->skills !== null) {
            return [
                'exists' => true,
                'path' => rtrim($pathRaw, '/'),
                'type' => 'dir',
                'size_bytes' => null,
                'modified_at' => null,
            ];
        }

        $root = $this->root ?? dirname(__DIR__, 2);
        $realRoot = realpath($root) ?: $root;
        $candidate = str_starts_with($pathRaw, '/') ? $pathRaw : $realRoot . '/' . $pathRaw;
        $real = realpath($candidate);

        if ($real === false) {
            if ($requireExisting) {
                throw new InvalidArgumentException('path not found');
            }
            return [
                'exists' => false,
                'path' => $this->relativePath($realRoot, $candidate),
            ];
        }

        if ($real !== $realRoot && !str_starts_with($real, rtrim($realRoot, '/') . '/')) {
            throw new InvalidArgumentException('path is outside allowed root');
        }

        $stat = @stat($real);
        $mtime = isset($stat['mtime']) ? gmdate(DATE_ATOM, (int) $stat['mtime']) : null;
        $size = $stat['size'] ?? null;
        $isDir = is_dir($real);

        return [
            'exists' => true,
            'path' => $this->relativePath($realRoot, $real),
            'type' => $isDir ? 'dir' : 'file',
            'size_bytes' => $isDir ? null : $size,
            'modified_at' => $mtime,
        ];
    }

    /**
     * Search within files under a root with optional glob filters.
     *
     * @param array{root?:mixed,pattern?:mixed,file_glob?:mixed,max_results?:mixed} $args
     * @return array<string,mixed>
     */
    public function searchInFiles(array $args): array
    {
        $rootRaw = $args['root'] ?? null;
        $patternRaw = $args['pattern'] ?? null;
        if (!is_string($rootRaw) || trim($rootRaw) === '') {
            throw new InvalidArgumentException('root is required');
        }
        if (!is_string($patternRaw) || $patternRaw === '') {
            throw new InvalidArgumentException('pattern is required');
        }

        $globs = [];
        if (isset($args['file_glob']) && is_array($args['file_glob'])) {
            foreach ($args['file_glob'] as $g) {
                if (is_string($g) && $g !== '') {
                    $globs[] = $g;
                }
            }
        }

        $max = 200;
        if (isset($args['max_results']) && is_numeric($args['max_results'])) {
            $max = max(1, min(1000, (int) $args['max_results']));
        }

        $rootBase = $this->root ?? dirname(__DIR__, 2);
        $realBase = realpath($rootBase) ?: $rootBase;
        $candidate = str_starts_with($rootRaw, '/') ? $rootRaw : $realBase . '/' . $rootRaw;
        $realRoot = realpath($candidate);
        if ($realRoot === false || !is_dir($realRoot)) {
            throw new InvalidArgumentException('root directory not found');
        }
        if ($realRoot !== $realBase && !str_starts_with($realRoot, rtrim($realBase, '/') . '/')) {
            throw new InvalidArgumentException('root is outside allowed base');
        }

        $regex = '/' . preg_quote($patternRaw, '/') . '/i';

        $matches = [];
        $rii = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($realRoot, \FilesystemIterator::SKIP_DOTS));
        foreach ($rii as $fileInfo) {
            if ($fileInfo->isDir()) {
                continue;
            }

            $relativePath = $this->relativePath($realBase, $fileInfo->getPathname());
            $filename = $fileInfo->getFilename();

            if ($globs) {
                $keep = false;
                foreach ($globs as $g) {
                    if (fnmatch($g, $filename, FNM_PATHNAME) || fnmatch($g, $relativePath, FNM_PATHNAME)) {
                        $keep = true;
                        break;
                    }
                }
                if (!$keep) {
                    continue;
                }
            }

            $content = @file($fileInfo->getPathname(), FILE_IGNORE_NEW_LINES);
            if ($content === false) {
                continue;
            }

            foreach ($content as $idx => $line) {
                if (preg_match($regex, $line) === 1) {
                    $matches[] = [
                        'file' => $relativePath,
                        'line' => $idx + 1,
                        'snippet' => $this->truncateLine($line),
                    ];
                    if (count($matches) >= $max) {
                        break 2;
                    }
                }
            }
        }

        return [
            'pattern' => $patternRaw,
            'root' => $this->relativePath($realBase, $realRoot),
            'count' => count($matches),
            'matches' => $matches,
        ];
    }

    /**
     * Extract a skill slug from a filesystem path matching skill directory conventions.
     */
    private function extractSkillSlugFromPath(string $path): ?string
    {
        if (preg_match('#(?:\.agents|\.codex)/skills/([A-Za-z0-9._-]+)/SKILL\.md$#', $path, $m)) {
            return $m[1];
        }

        return null;
    }

    /**
     * Return true when $path points at a skills directory root.
     */
    private function isSkillsDirectory(string $path): bool
    {
        $normalized = rtrim($path, '/');

        return (bool) preg_match('#(?:\.agents|\.codex)/skills$#', $normalized);
    }

    private function relativePath(string $root, string $full): string
    {
        $root = rtrim($root, '/') . '/';
        return str_starts_with($full, $root) ? substr($full, strlen($root)) : $full;
    }

    private function truncateLine(string $value): string
    {
        $trimmed = rtrim($value, "\r\n");
        if (strlen($trimmed) <= 200) {
            return $trimmed;
        }

        return substr($trimmed, 0, 197) . '...';
    }
}
