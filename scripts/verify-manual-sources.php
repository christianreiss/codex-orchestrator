<?php

declare(strict_types=1);

/**
 * Verify that every source path referenced by an online-manual article still exists.
 *
 * Each article in public/admin/manual/articles/*.md carries YAML-lite front matter:
 *
 *     ---
 *     title: Whatever
 *     verified: 2026-04-19
 *     sources: path/one.php, path/two.php
 *     ---
 *
 * This script reads the front matter, asserts every listed source path exists
 * (paths are resolved relative to the repository root), and warns if the
 * `verified:` date is older than STALE_DAYS.
 *
 * Exits non-zero when a source is missing; a stale verification is a warning only.
 */

const STALE_DAYS = 180;

$root = dirname(__DIR__);
$articlesDir = $root . '/public/admin/manual/articles';
$manifestPath = $root . '/public/admin/manual/manifest.json';

if (!is_dir($articlesDir)) {
    fwrite(STDERR, "articles dir not found: $articlesDir\n");
    exit(2);
}

$articles = glob($articlesDir . '/*.md');
if ($articles === false || count($articles) === 0) {
    fwrite(STDERR, "no articles found in $articlesDir\n");
    exit(2);
}

$missing = [];
$stale = [];
$noSources = [];
$total = 0;

foreach ($articles as $path) {
    $slug = basename($path, '.md');
    $raw = file_get_contents($path);
    if ($raw === false || $raw === '') {
        $missing[] = "$slug: empty article";
        continue;
    }
    if (!str_starts_with($raw, '---')) {
        $noSources[] = $slug;
        continue;
    }
    $end = strpos($raw, "\n---", 3);
    if ($end === false) {
        $noSources[] = $slug;
        continue;
    }
    /** @var array<string, string> $front */
    $front = [];
    foreach (explode("\n", substr($raw, 3, $end - 3)) as $line) {
        $idx = strpos($line, ':');
        if ($idx === false) continue;
        $key = trim(substr($line, 0, $idx));
        $rawValue = trim(substr($line, $idx + 1));
        $value = preg_replace('/^["\']|["\']$/', '', $rawValue) ?? $rawValue;
        if ($key !== '') $front[$key] = $value;
    }

    $sources = [];
    if (isset($front['sources']) && $front['sources'] !== '') {
        $parts = array_map('trim', explode(',', $front['sources']));
        $sources = array_values(array_filter($parts, static fn (string $v): bool => $v !== ''));
    }

    if (count($sources) === 0) {
        $noSources[] = $slug;
    }

    foreach ($sources as $src) {
        $total++;
        // Strip optional " (note)" suffix so "src/x.php (lines 10-20)" still resolves.
        $stripped = preg_replace('/\s*\(.*$/', '', $src);
        $pathOnly = $stripped ?? $src;
        $full = $root . '/' . ltrim($pathOnly, '/');
        if (!file_exists($full)) {
            $missing[] = "$slug: missing source '$src'";
        }
    }

    if (isset($front['verified']) && $front['verified'] !== '') {
        $verified = strtotime($front['verified']);
        if ($verified !== false) {
            $age = (time() - $verified) / 86400;
            if ($age > STALE_DAYS) {
                $stale[] = sprintf('%s: verified %s (%d days ago)', $slug, $front['verified'], (int) $age);
            }
        }
    }
}

printf("checked %d source paths across %d articles\n", $total, count($articles));

if (count($noSources) > 0) {
    echo "\narticles with no sources: field:\n";
    foreach ($noSources as $slug) echo "  - $slug\n";
}

if (count($stale) > 0) {
    echo "\nstale verifications (>{STALE_DAYS} days):\n";
    foreach ($stale as $line) echo "  - $line\n";
}

if (count($missing) > 0) {
    echo "\nmissing source files:\n";
    foreach ($missing as $line) echo "  - $line\n";
    exit(1);
}

echo "\nall sources resolve.\n";
exit(0);
