#!/usr/bin/env php
<?php
declare(strict_types=1);

$root = dirname(__DIR__);
$sourcePath = $root . '/AGENTS.md';

if (!is_file($sourcePath) || !is_readable($sourcePath)) {
    fwrite(STDERR, "Source AGENTS.md not found at {$sourcePath}\n");
    exit(1);
}

$sourceContents = file_get_contents($sourcePath);
if ($sourceContents === false || $sourceContents === '') {
    fwrite(STDERR, "Source AGENTS.md is empty or unreadable.\n");
    exit(1);
}

$codexHome = getenv('CODEX_HOME');
if ($codexHome === false || $codexHome === '') {
    $home = getenv('HOME');
    if ($home === false || $home === '') {
        fwrite(STDERR, "HOME is not defined and CODEX_HOME is unset; cannot determine target directory.\n");
        exit(1);
    }
    $codexHome = rtrim($home, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . '.codex';
}

$codexHome = rtrim($codexHome, DIRECTORY_SEPARATOR);

if ($codexHome === '') {
    fwrite(STDERR, "Resolved CODEX home is empty; aborting.\n");
    exit(1);
}

if (!is_dir($codexHome)) {
    if (!mkdir($codexHome, 0700, true) && !is_dir($codexHome)) {
        fwrite(STDERR, "Failed to create directory {$codexHome}.\n");
        exit(1);
    }
}

$targetPath = $codexHome . DIRECTORY_SEPARATOR . 'AGENTS.md';
$existingContents = is_file($targetPath) ? file_get_contents($targetPath) : false;

if ($existingContents === $sourceContents) {
    fwrite(STDOUT, "AGENTS.md already up to date at {$targetPath}.\n");
    exit(0);
}

if (file_put_contents($targetPath, $sourceContents) === false) {
    fwrite(STDERR, "Failed to write {$targetPath}.\n");
    exit(1);
}

@chmod($targetPath, 0600);

fwrite(STDOUT, "Synced AGENTS.md to {$targetPath}.\n");
