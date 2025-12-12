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

// Admin TLS policy (kept in sync with public/index.php).
// Default is mTLS required unless ADMIN_ACCESS_MODE is explicitly set to "none".
$mode = getenv('ADMIN_ACCESS_MODE');
if ($mode === false && array_key_exists('ADMIN_ACCESS_MODE', $_ENV)) {
    $mode = (string) $_ENV['ADMIN_ACCESS_MODE'];
}
$mode = strtolower(trim((string) ($mode === false ? 'mtls' : $mode)));
$mtlsRequired = $mode !== 'none';

function isMobileUserAgent(string $userAgent): bool
{
    return preg_match('/android|iphone|ipad|ipod|mobile|blackberry|phone|opera mini|windows phone/i', $userAgent) === 1;
}

$fpRaw = is_string($mtlsFingerprint) && $mtlsFingerprint !== '' ? $mtlsFingerprint : $mtlsPresent;
$fp = is_string($fpRaw) ? preg_replace('/[^A-Fa-f0-9]/', '', $fpRaw) : '';
$hasValidFingerprint = is_string($fp) && strlen($fp) >= 64 && preg_match('/^[A-Fa-f0-9]+$/', $fp) === 1;

// Require mTLS when configured.
if ($mtlsRequired && !$hasValidFingerprint) {
    header('Content-Type: text/plain; charset=utf-8', true, 403);
    echo 'Client certificate required for admin access.';
    exit;
}

// No passkey system; admin enforcement is mTLS-only (or disabled explicitly).

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
