<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Response;
use App\Services\AuthService;
use App\Services\WrapperService;

class WrapperController
{
    private AuthService $service;
    private WrapperService $wrapperService;

    public function __construct(AuthService $service, WrapperService $wrapperService)
    {
        $this->service = $service;
        $this->wrapperService = $wrapperService;
    }

    /** GET /wrapper — return wrapper metadata (without content). */
    public function meta(): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $host = $this->service->authenticate($apiKey, $clientIp);
        $baseUrl = resolveBaseUrl();
        $meta = $this->wrapperService->bakedForHost($host, $baseUrl);
        if ($meta['content'] === null || $meta['version'] === null) {
            Response::json([
                'status' => 'error',
                'message' => 'Wrapper not available',
            ], 404);
        }

        unset($meta['content']);
        Response::json([
            'status' => 'ok',
            'data' => $meta,
        ]);
    }

    /** GET /wrapper/download — stream the baked wrapper shell script. */
    public function download(): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $host = $this->service->authenticate($apiKey, $clientIp);
        $baseUrl = resolveBaseUrl();
        $meta = $this->wrapperService->bakedForHost($host, $baseUrl);
        if ($meta['version'] === null || $meta['content'] === null) {
            Response::json([
                'status' => 'error',
                'message' => 'Wrapper not available',
            ], 404);
        }

        $fileName = 'cdx-' . ($meta['version'] ?? 'latest') . '.sh';
        header('Content-Type: text/x-shellscript');
        header('Content-Disposition: attachment; filename="' . $fileName . '"');
        if ($meta['sha256']) {
            header('X-SHA256: ' . $meta['sha256']);
            header('ETag: "' . $meta['sha256'] . '"');
        }
        if ($meta['size_bytes'] !== null) {
            header('Content-Length: ' . $meta['size_bytes']);
        }
        echo $meta['content'];
        exit;
    }
}
