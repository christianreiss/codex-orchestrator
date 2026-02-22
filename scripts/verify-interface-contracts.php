#!/usr/bin/env php
<?php

declare(strict_types=1);

$root = dirname(__DIR__);
$contractsDir = $root . '/docs/contracts';
$apiDocPath = $root . '/docs/interface-api.md';
$cdxDocPath = $root . '/docs/interface-cdx.md';
$overviewDocPath = $root . '/docs/OVERVIEW.md';

$errors = [];

$requireFile = static function (string $path) use (&$errors): ?string {
    $content = @file_get_contents($path);
    if (!is_string($content)) {
        $errors[] = "Unable to read required file: {$path}";
        return null;
    }

    return $content;
};

$loadJsonObject = static function (string $path) use (&$errors): ?array {
    $content = @file_get_contents($path);
    if (!is_string($content)) {
        $errors[] = "Unable to read contract schema: {$path}";
        return null;
    }
    $decoded = json_decode($content, true);
    if (!is_array($decoded)) {
        $errors[] = "Invalid JSON contract schema: {$path}";
        return null;
    }

    return $decoded;
};

$authRetrieveSchemaPath = $contractsDir . '/auth-retrieve.schema.json';
$authStoreSchemaPath = $contractsDir . '/auth-store.schema.json';
$versionsSchemaPath = $contractsDir . '/versions.schema.json';
$usageSchemaPath = $contractsDir . '/usage-ingest.schema.json';
$syncStatusSchemaPath = $contractsDir . '/sync-status.schema.json';
$syncBootstrapSchemaPath = $contractsDir . '/sync-bootstrap.schema.json';

$authRetrieveSchema = $loadJsonObject($authRetrieveSchemaPath);
$authStoreSchema = $loadJsonObject($authStoreSchemaPath);
$versionsSchema = $loadJsonObject($versionsSchemaPath);
$usageSchema = $loadJsonObject($usageSchemaPath);
$syncStatusSchema = $loadJsonObject($syncStatusSchemaPath);
$syncBootstrapSchema = $loadJsonObject($syncBootstrapSchemaPath);
$apiDoc = $requireFile($apiDocPath);
$cdxDoc = $requireFile($cdxDocPath);
$overviewDoc = $requireFile($overviewDocPath);

if (
    $authRetrieveSchema !== null
    && $authStoreSchema !== null
    && $versionsSchema !== null
    && $usageSchema !== null
    && $syncStatusSchema !== null
    && $syncBootstrapSchema !== null
    && $apiDoc !== null
    && $cdxDoc !== null
    && $overviewDoc !== null
) {
    $retrieveStatuses = $authRetrieveSchema['properties']['data']['properties']['status']['enum'] ?? [];
    $storeStatuses = $authStoreSchema['properties']['data']['properties']['status']['enum'] ?? [];
    $versionRequired = $versionsSchema['properties']['data']['required'] ?? [];
    $usageRequired = $usageSchema['properties']['data']['required'] ?? [];

    foreach ($retrieveStatuses as $status) {
        if (!is_string($status)) {
            continue;
        }
        if (strpos($apiDoc, $status) === false) {
            $errors[] = "docs/interface-api.md missing retrieve status from contract: {$status}";
        }
    }

    foreach ($storeStatuses as $status) {
        if (!is_string($status)) {
            continue;
        }
        if (strpos($apiDoc, $status) === false) {
            $errors[] = "docs/interface-api.md missing store status from contract: {$status}";
        }
    }

    // Auth deny reason codes that must be documented for wrapper/operator troubleshooting.
    $requiredDenyCodes = [
        'reverse_dns_mismatch',
        'insecure_api_disabled',
        'installation_mismatch',
    ];
    foreach ($requiredDenyCodes as $code) {
        if (strpos($apiDoc, $code) === false) {
            $errors[] = "docs/interface-api.md missing deny reason code: {$code}";
        }
    }

    // Wrapper-facing deny reasons should be documented where cdx behavior is described.
    $requiredWrapperReasons = [
        'reverse DNS mismatches',
        'approval pending',
        'approval denied',
        'API kill-switch',
    ];
    foreach ($requiredWrapperReasons as $phrase) {
        if (stripos($cdxDoc, $phrase) === false) {
            $errors[] = "docs/interface-cdx.md missing wrapper reason phrase: {$phrase}";
        }
    }

    foreach ($versionRequired as $field) {
        if (!is_string($field)) {
            continue;
        }
        if (strpos($apiDoc, $field) === false) {
            $errors[] = "docs/interface-api.md missing /versions field listed in contract: {$field}";
        }
    }

    foreach ($usageRequired as $field) {
        if (!is_string($field)) {
            continue;
        }
        if (strpos($apiDoc, $field) === false) {
            $errors[] = "docs/interface-api.md missing /usage response field listed in contract: {$field}";
        }
    }

    $contractFiles = [
        'auth-retrieve.schema.json',
        'auth-store.schema.json',
        'versions.schema.json',
        'usage-ingest.schema.json',
        'sync-status.schema.json',
        'sync-bootstrap.schema.json',
    ];
    foreach ($contractFiles as $contractFile) {
        if (strpos($apiDoc, $contractFile) === false) {
            $errors[] = "docs/interface-api.md must reference docs/contracts/{$contractFile}";
        }
    }

    if (strpos($overviewDoc, 'docs/contracts') === false) {
        $errors[] = 'docs/OVERVIEW.md must mention docs/contracts contract coverage.';
    }
}

if ($errors !== []) {
    fwrite(STDERR, "Interface contract verification failed:\n");
    foreach ($errors as $error) {
        fwrite(STDERR, " - {$error}\n");
    }
    exit(1);
}

fwrite(STDOUT, "Interface contract verification passed.\n");
exit(0);
