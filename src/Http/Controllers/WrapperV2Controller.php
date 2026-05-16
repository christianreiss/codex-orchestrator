<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Response;
use App\Http\VersionHelper;
use App\Services\AuthService;
use App\Services\Wrapper\V2\BakeCache;
use App\Services\Wrapper\V2\BinaryRegistry;
use App\Services\Wrapper\V2\BootstrapShimBuilder;
use App\Services\Wrapper\V2\ConfigBaker;
use App\Support\Engine;

/**
 * Wrapper bakery v2 endpoints. Every endpoint is host-authenticated via
 * X-API-Key (resolveApiKey() + AuthService::authenticate). The actual baking
 * happens inside ConfigBaker; this controller is responsible for HTTP shape,
 * caching headers, and choosing which artifact (config, signature, binary) to
 * return.
 */
class WrapperV2Controller
{
    public function __construct(
        private readonly AuthService $service,
        private readonly ConfigBaker $baker,
        private readonly BakeCache $cache,
        private readonly BinaryRegistry $binaries,
    ) {
    }

    /** GET /wrapper/v2/meta — return current binary version + signing fingerprint per engine. */
    public function meta(): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $engine = VersionHelper::extractEngine(null);
        $this->service->authenticate($apiKey, $clientIp);

        $baseUrl = resolveBaseUrl();
        Response::json([
            'status' => 'ok',
            'data' => [
                'engine'    => $engine,
                'binaries'  => $this->binaries->manifest($engine, $baseUrl),
                'schema_version' => ConfigBaker::SCHEMA_VERSION,
            ],
        ]);
    }

    /** GET /wrapper/v2/config — return the signed per-host config (or signature if ?sig=1). */
    public function config(): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $engine = VersionHelper::extractEngine(null);
        $host = $this->service->authenticate($apiKey, $clientIp);
        $baseUrl = resolveBaseUrl();
        $hostId = (int) ($host['id'] ?? 0);

        $current = $this->cache->getCurrent($hostId, $engine);
        if ($current === null) {
            $current = $this->baker->bakeForHost($hostId, $engine, $baseUrl);
        }
        $configVersion = (int) $current['config_version'];
        $etag = (string) $current['etag'];

        $wantSig = isset($_GET['sig']) && $_GET['sig'] !== '0' && $_GET['sig'] !== '';
        $body = $wantSig
            ? $this->cache->signatureBody($hostId, $engine, $configVersion)
            : $this->cache->configBody($hostId, $engine, $configVersion);

        if ($body === null) {
            // Cache hole — re-bake synchronously.
            $current = $this->baker->bakeForHost($hostId, $engine, $baseUrl);
            $configVersion = (int) $current['config_version'];
            $etag = (string) $current['etag'];
            $body = $wantSig
                ? $this->cache->signatureBody($hostId, $engine, $configVersion)
                : $this->cache->configBody($hostId, $engine, $configVersion);
        }
        if ($body === null) {
            Response::json(['status' => 'error', 'message' => 'config unavailable'], 500);
        }

        header('Content-Type: ' . ($wantSig ? 'text/plain' : 'application/json'));
        header('ETag: "' . $etag . '"');
        header('X-SHA256: ' . $etag);
        header('X-Config-Version: ' . $configVersion);
        header('Cache-Control: private, max-age=10');
        header('Content-Length: ' . strlen($body));
        echo $body;
        exit;
    }

    /** GET /wrapper/v2/download — return the bootstrap shim for this host. */
    public function download(): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $engine = VersionHelper::extractEngine(null);
        $host = $this->service->authenticate($apiKey, $clientIp);
        $baseUrl = resolveBaseUrl();
        $hostApiKey = $apiKey ?? '';
        $shim = BootstrapShimBuilder::build($engine, $baseUrl, $hostApiKey);

        $name = Engine::WRAPPER_NAME[$engine] ?? 'cdx';
        header('Content-Type: text/x-shellscript');
        header('Content-Disposition: attachment; filename="' . $name . '-bootstrap.sh"');
        header('Content-Length: ' . strlen($shim));
        echo $shim;
        exit;
    }

    /**
     * GET /wrapper/v2/bin/{engine}/{platform}/v{version}/{binary}
     * Serve a static binary from storage/wrapper/v2/bin. Cache-friendly: SHA256
     * is the ETag and is precomputed (the BinaryRegistry computes it once per
     * boot of the binary registry — not per request).
     */
    public function binary(string $engine, string $platform, string $version, string $binary): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $this->service->authenticate($apiKey, $clientIp);

        $engine = (string) $engine;
        if (!Engine::isValid($engine)) {
            Response::json(['status' => 'error', 'message' => 'unknown engine'], 404);
        }
        if (!preg_match('/^([a-z0-9]+)-([a-z0-9]+)$/', $platform, $m)) {
            Response::json(['status' => 'error', 'message' => 'bad platform'], 404);
        }
        [, $os, $arch] = $m;
        $version = ltrim($version, 'v');
        $expectedName = Engine::WRAPPER_NAME[$engine] ?? '';
        if ($binary !== $expectedName) {
            Response::json(['status' => 'error', 'message' => 'binary mismatch'], 404);
        }

        $path = $this->binaries->path($engine, $os, $arch, $version);
        if ($path === null) {
            Response::json(['status' => 'error', 'message' => 'binary not found'], 404);
        }

        $sha = $this->binaries->sha256($engine, $os, $arch, $version) ?? '';
        $ifNone = $_SERVER['HTTP_IF_NONE_MATCH'] ?? '';
        if ($sha !== '' && $ifNone !== '' && trim($ifNone, '"') === $sha) {
            http_response_code(304);
            header('ETag: "' . $sha . '"');
            exit;
        }

        header('Content-Type: application/octet-stream');
        header('Content-Disposition: attachment; filename="' . $binary . '"');
        header('ETag: "' . $sha . '"');
        header('X-SHA256: ' . $sha);
        header('Cache-Control: public, max-age=86400, immutable');
        $size = filesize($path) ?: 0;
        header('Content-Length: ' . $size);
        readfile($path);
        exit;
    }

    /** GET /wrapper/v2/manifest/{engine} — per-platform inventory (sha256+url). */
    public function manifest(string $engine): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $this->service->authenticate($apiKey, $clientIp);
        if (!Engine::isValid((string) $engine)) {
            Response::json(['status' => 'error', 'message' => 'unknown engine'], 404);
        }
        Response::json([
            'status' => 'ok',
            'data'   => $this->binaries->manifest((string) $engine, resolveBaseUrl()),
        ]);
    }
}
