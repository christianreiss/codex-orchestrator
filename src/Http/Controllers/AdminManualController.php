<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Response;

/**
 * Serves the admin online manual: manifest, article bodies, and search index.
 *
 * Content lives on disk under public/admin/manual/ and is authored as
 * front-matter-prefixed markdown. All endpoints require an authenticated
 * admin session.
 */
class AdminManualController
{
    private string $manualDir;

    public function __construct(string $publicDir)
    {
        $this->manualDir = rtrim($publicDir, '/') . '/admin/manual';
    }

    /** GET /admin/manual/manifest */
    public function manifest(): void
    {
        requireAdminAccess();
        $path = $this->manualDir . '/manifest.json';
        $this->serveJsonFile($path, 'manifest');
    }

    /** GET /admin/manual/search */
    public function searchIndex(): void
    {
        requireAdminAccess();
        $path = $this->manualDir . '/search-index.json';
        $this->serveJsonFile($path, 'search-index');
    }

    /** GET /admin/manual/article/{slug} */
    public function article(string $slug): void
    {
        requireAdminAccess();

        if (preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/', $slug) !== 1) {
            Response::json(['status' => 'error', 'message' => 'Invalid article slug'], 400);
            return;
        }

        $path = $this->manualDir . '/articles/' . $slug . '.md';
        $real = realpath($path);
        $articlesRoot = realpath($this->manualDir . '/articles');
        if ($real === false || $articlesRoot === false || !str_starts_with($real, $articlesRoot . DIRECTORY_SEPARATOR)) {
            Response::json(['status' => 'error', 'message' => 'Article not found'], 404);
            return;
        }

        $body = @file_get_contents($real);
        if ($body === false) {
            Response::json(['status' => 'error', 'message' => 'Article not readable'], 500);
            return;
        }

        $this->emit($body, 'text/plain; charset=utf-8');
    }

    private function serveJsonFile(string $path, string $label): void
    {
        if (!is_readable($path)) {
            Response::json(['status' => 'error', 'message' => ucfirst($label) . ' unavailable'], 404);
            return;
        }

        $body = @file_get_contents($path);
        if ($body === false) {
            Response::json(['status' => 'error', 'message' => ucfirst($label) . ' unreadable'], 500);
            return;
        }

        $this->emit($body, 'application/json; charset=utf-8');
    }

    private function emit(string $body, string $contentType): void
    {
        $etag = '"' . sha1($body) . '"';
        $rawIfNoneMatch = $_SERVER['HTTP_IF_NONE_MATCH'] ?? '';
        $ifNoneMatch = is_string($rawIfNoneMatch) ? trim($rawIfNoneMatch) : '';
        if ($ifNoneMatch !== '' && $ifNoneMatch === $etag) {
            http_response_code(304);
            header('ETag: ' . $etag);
            exit;
        }

        http_response_code(200);
        header('Content-Type: ' . $contentType);
        header('X-Content-Type-Options: nosniff');
        header('ETag: ' . $etag);
        header('Cache-Control: private, max-age=0, must-revalidate');
        echo $body;
        exit;
    }
}
