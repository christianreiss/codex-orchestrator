<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

use App\Config;
use App\Database;
use App\Repositories\AdminPasskeyRepository;
use App\Repositories\AdminPasswordResetRepository;
use App\Repositories\AdminSessionRepository;
use App\Repositories\AdminUserRepository;
use App\Repositories\LogRepository;
use App\Services\AdminAuthService;
use App\Support\Mailer;

// Bootstrap env (mirrors public/index.php).
require_once dirname(__DIR__, 2) . '/vendor/autoload.php';
if (file_exists(dirname(__DIR__, 2) . '/.env')) {
    Dotenv\Dotenv::createImmutable(dirname(__DIR__, 2))->safeLoad();
}

// Stop HTML error leakage in admin if exceptions happen before front-end loads.
ini_set('display_errors', '0');
ini_set('html_errors', '0');

$mtlsPresent = $_SERVER['HTTP_X_MTLS_PRESENT'] ?? '';
$mtlsFingerprint = $_SERVER['HTTP_X_MTLS_FINGERPRINT'] ?? '';
$mtlsSubject = $_SERVER['HTTP_X_MTLS_SUBJECT'] ?? '';
$mtlsIssuer = $_SERVER['HTTP_X_MTLS_ISSUER'] ?? '';

// Admin TLS policy (kept in sync with public/index.php).
// Default is mTLS required unless ADMIN_ACCESS_MODE is explicitly set to "none".
$mode = getenv('ADMIN_ACCESS_MODE');
if ($mode === false && array_key_exists('ADMIN_ACCESS_MODE', $_ENV)) {
    $mode = (string) $_ENV['ADMIN_ACCESS_MODE'];
}
$mode = strtolower(trim((string) ($mode === false ? 'mtls' : $mode)));
$mtlsRequired = $mode !== 'none';

function redirectTo(string $path): void
{
    header('Location: ' . $path, true, 302);
    exit;
}

function renderAdminErrorPage(int $status, string $title, string $message, ?string $details = null): void
{
    $escape = static fn(string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $detailMarkup = '';
    if ($details !== null && $details !== '') {
        $detailMarkup = '<p class="admin-error-meta">' . $escape($details) . '</p>';
    }

    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    header('X-Admin-Page: error');

    echo '<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Orchestrator &mdash; Admin access</title>
  <link rel="stylesheet" href="/admin/assets/theme.css?v=2026-03-17-01">
</head>
<body class="admin-error-body" data-theme="auto">
  <main class="admin-error-shell" aria-labelledby="adminErrorTitle">
    <section class="admin-error-card">
      <div class="admin-error-header">
        <div class="admin-error-mark">
          <img class="admin-error-logo" src="/admin/assets/openai-logo.svg" alt="OpenAI logo">
        </div>
        <div>
          <span class="admin-error-eyebrow">HTTP ' . $status . '</span>
          <h1 id="adminErrorTitle" class="admin-error-title">' . $escape($title) . '</h1>
        </div>
      </div>
      <p class="admin-error-copy">' . $escape($message) . '</p>
      ' . $detailMarkup . '
      <div class="admin-error-actions">
        <a class="admin-error-link" href="/admin/">Retry admin access</a>
        <a class="admin-error-link ghost" href="/admin/login">Open login</a>
      </div>
    </section>
  </main>
</body>
</html>';
    exit;
}

function isMobileUserAgent(string $userAgent): bool
{
    return preg_match('/android|iphone|ipad|ipod|mobile|blackberry|phone|opera mini|windows phone/i', $userAgent) === 1;
}

$fpRaw = is_string($mtlsFingerprint) && $mtlsFingerprint !== '' ? $mtlsFingerprint : $mtlsPresent;
$fp = is_string($fpRaw) ? preg_replace('/[^A-Fa-f0-9]/', '', $fpRaw) : '';
$hasValidFingerprint = is_string($fp) && strlen($fp) >= 64 && preg_match('/^[A-Fa-f0-9]+$/', $fp) === 1;

// Require mTLS when configured.
if ($mtlsRequired && !$hasValidFingerprint) {
    renderAdminErrorPage(
        403,
        'Client certificate required',
        'Admin access is locked behind mTLS on this instance, so the browser request needs a valid client certificate before the login page or dashboard can load.',
        'Provide a trusted client certificate or switch ADMIN_ACCESS_MODE to none if another boundary is handling access.'
    );
}

$root = dirname(__DIR__, 2);
$adminAuthService = null;

try {
    $database = new Database([
        'driver' => Config::get('DB_DRIVER', 'mysql'),
        'host' => Config::get('DB_HOST', 'mysql'),
        'port' => (int) Config::get('DB_PORT', 3306),
        'database' => Config::get('DB_DATABASE', 'codex_auth'),
        'username' => Config::get('DB_USERNAME', 'codex'),
        'password' => Config::get('DB_PASSWORD', 'codex-pass'),
        'charset' => Config::get('DB_CHARSET', 'utf8mb4'),
    ]);

    // Keep schema bootstrap behavior aligned with public/index.php.
    $schemaHash = hash_file('sha256', $root . '/src/Database.php') ?: '';
    $schemaKey = $schemaHash !== '' ? substr($schemaHash, 0, 12) : 'unknown';
    $sentinelDir = $root . '/storage/wrapper';
    if (!is_dir($sentinelDir)) {
        @mkdir($sentinelDir, 0775, true);
    }
    $migrateSentinel = $sentinelDir . '/.db_migrated_' . $schemaKey;
    $migrateLockPath = $sentinelDir . '/.db_migrate.lock';
    if (!is_file($migrateSentinel)) {
        $lock = @fopen($migrateLockPath, 'c+');
        if (is_resource($lock)) {
            @flock($lock, LOCK_EX);
        }
        if (!is_file($migrateSentinel)) {
            $database->migrate();
            @file_put_contents($migrateSentinel, gmdate(DATE_ATOM) . "\n");
        }
        if (is_resource($lock)) {
            @flock($lock, LOCK_UN);
            @fclose($lock);
        }
    }

    $adminAuthService = new AdminAuthService(
        new AdminUserRepository($database),
        new AdminSessionRepository($database),
        new AdminPasswordResetRepository($database),
        new LogRepository($database),
        new Mailer(),
        new AdminPasskeyRepository($database)
    );
} catch (\Throwable $exception) {
    error_log('[admin] auth bootstrap failed: ' . $exception->getMessage());
}

$requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/admin', PHP_URL_PATH);
if (!is_string($requestPath) || $requestPath === '') {
    $requestPath = '/admin';
}
$normalizedPath = rtrim($requestPath, '/');
if ($normalizedPath === '') {
    $normalizedPath = '/';
}

$isLoginRoute = $normalizedPath === '/admin/login';
$isDashboardRoute = !$isLoginRoute;
$adminSession = null;
$loginEnforced = false;

if ($adminAuthService instanceof AdminAuthService) {
    try {
        $loginEnforced = $adminAuthService->isEnforced();
        $cookieName = $adminAuthService->sessionCookieName();
        $tokenRaw = $_COOKIE[$cookieName] ?? null;
        $token = is_string($tokenRaw) ? trim($tokenRaw) : '';
        if ($token !== '') {
            $adminSession = $adminAuthService->resolveSession($token);
        }
    } catch (\Throwable $exception) {
        error_log('[admin] auth session lookup failed: ' . $exception->getMessage());
    }
}

$isAuthenticated = is_array($adminSession) && isset($adminSession['user']);

if ($isDashboardRoute && $loginEnforced && !$isAuthenticated) {
    redirectTo('/admin/login');
}

if ($isLoginRoute && (!$loginEnforced || $isAuthenticated)) {
    redirectTo('/admin/');
}

$html = $isLoginRoute ? __DIR__ . '/login.html' : __DIR__ . '/index.html';
if (!is_file($html)) {
    renderAdminErrorPage(
        500,
        'Admin UI missing',
        $isLoginRoute
            ? 'The standalone admin login page could not be found on disk.'
            : 'The admin dashboard shell could not be found on disk.',
        $html
    );
}

$shouldServeMobile = false;
if (!$isLoginRoute) {
    $viewParam = $_GET['view'] ?? '';
    if (is_array($viewParam)) {
        $viewParam = '';
    }
    $viewParam = strtolower(trim((string) $viewParam));
    $forceMobile = $viewParam === 'mobile';
    $forceDesktop = $viewParam === 'desktop';
    $shouldServeMobile = !$forceDesktop && ($forceMobile || isMobileUserAgent($_SERVER['HTTP_USER_AGENT'] ?? ''));
}

$content = file_get_contents($html);
if ($content === false) {
    renderAdminErrorPage(
        500,
        'Admin UI unreadable',
        $isLoginRoute
            ? 'The admin login page exists, but PHP could not read it.'
            : 'The admin dashboard shell exists, but PHP could not read it.',
        $html
    );
}

if (!$isLoginRoute && $shouldServeMobile) {
    $content = str_replace('data-view="desktop"', 'data-view="mobile"', $content, $count);
    if ($count === 0) {
        $content = preg_replace('/<body(\\s*)>/', '<body data-view="mobile">', $content, 1);
    }
}

header('Content-Type: text/html; charset=utf-8');
header('X-Admin-Page: ' . ($isLoginRoute ? 'login' : 'dashboard'));
if (!$isLoginRoute) {
    header('X-Dashboard-View: ' . ($shouldServeMobile ? 'mobile' : 'desktop'));
}
echo $content;
