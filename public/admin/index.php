<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

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

// Interpret admin access mode (kept in sync with public/index.php)
$mode = strtolower((string) (getenv('ADMIN_ACCESS_MODE') ?: ($_ENV['ADMIN_ACCESS_MODE'] ?? 'mtls_and_passkey')));
if (!in_array($mode, ['none', 'mtls_only', 'passkey_only', 'mtls_and_passkey'], true)) {
    $mode = 'mtls_and_passkey';
}
$mtlsRequired = in_array($mode, ['mtls_only', 'mtls_and_passkey'], true);
$passkeyRequired = in_array($mode, ['passkey_only', 'mtls_and_passkey'], true);

function isMobileUserAgent(string $userAgent): bool
{
    return preg_match('/android|iphone|ipad|ipod|mobile|blackberry|phone|opera mini|windows phone/i', $userAgent) === 1;
}

$hasValidFingerprint = is_string($mtlsFingerprint) && preg_match('/^[A-Fa-f0-9]{64}$/', $mtlsFingerprint) === 1;

// Require mTLS when configured.
if ($mtlsRequired && !$hasValidFingerprint) {
    header('Content-Type: text/plain; charset=utf-8', true, 403);
    echo 'Client certificate required for admin access.';
    exit;
}

// Require passkey when configured (passkey_present + last auth ok).
if ($passkeyRequired) {
    // Build DB config from environment (mirrors public/index.php bootstrap).
    $dbConfig = [
        'driver' => getenv('DB_DRIVER') ?: 'mysql',
        'host' => getenv('DB_HOST') ?: 'mysql',
        'port' => (int) (getenv('DB_PORT') ?: 3306),
        'database' => getenv('DB_DATABASE') ?: 'codex_auth',
        'username' => getenv('DB_USERNAME') ?: 'root',
        'password' => getenv('DB_PASSWORD') ?: '',
        'charset' => getenv('DB_CHARSET') ?: 'utf8mb4',
    ];
    $repo = new \App\Repositories\VersionRepository(
        new \App\Database($dbConfig)
    );
    $created = $repo->getFlag('passkey_created', false);
    $auth = $repo->get('passkey_auth') ?? 'none';
    $isPasskeyRoute = str_starts_with(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '', '/admin/passkey/');

    if (!$created && !$isPasskeyRoute) {
        header('Content-Type: text/plain; charset=utf-8', true, 401);
        echo 'Passkey enrollment required.';
        exit;
    }

    if ($created && $auth !== 'ok' && !$isPasskeyRoute) {
        header('Content-Type: text/plain; charset=utf-8', true, 401);
        echo 'Passkey authentication required.';
        exit;
    }
}

$html = __DIR__ . '/index.html';
if (!is_file($html)) {
    header('Content-Type: text/plain; charset=utf-8', true, 500);
    echo 'Admin UI missing';
    exit;
}

$viewParam = $_GET['view'] ?? '';
if (is_array($viewParam)) {
    $viewParam = '';
}
$viewParam = strtolower(trim((string) $viewParam));
$forceMobile = $viewParam === 'mobile';
$forceDesktop = $viewParam === 'desktop';
$shouldServeMobile = !$forceDesktop && ($forceMobile || isMobileUserAgent($_SERVER['HTTP_USER_AGENT'] ?? ''));

$content = file_get_contents($html);
if ($content === false) {
    header('Content-Type: text/plain; charset=utf-8', true, 500);
    echo 'Unable to load admin UI';
    exit;
}

if ($shouldServeMobile) {
    $content = str_replace('data-view="desktop"', 'data-view="mobile"', $content, $count);
    if ($count === 0) {
        $content = preg_replace('/<body(\\s*)>/', '<body data-view="mobile">', $content, 1);
    }
}

header('Content-Type: text/html; charset=utf-8');
header('X-Dashboard-View: ' . ($shouldServeMobile ? 'mobile' : 'desktop'));
echo $content;
