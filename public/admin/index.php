<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

$mtlsPresent = $_SERVER['HTTP_X_MTLS_PRESENT'] ?? '';
$mtlsFingerprint = $_SERVER['HTTP_X_MTLS_FINGERPRINT'] ?? '';
$mtlsSubject = $_SERVER['HTTP_X_MTLS_SUBJECT'] ?? '';
$mtlsIssuer = $_SERVER['HTTP_X_MTLS_ISSUER'] ?? '';

$mtlsRequired = true;
$envAdminMtls = getenv('ADMIN_REQUIRE_MTLS');
if ($envAdminMtls !== false) {
    $normalized = strtolower(trim((string) $envAdminMtls));
    if (in_array($normalized, ['0', 'false', 'off', 'no'], true)) {
        $mtlsRequired = false;
    }
}

function isMobileUserAgent(string $userAgent): bool
{
    return preg_match('/android|iphone|ipad|ipod|mobile|blackberry|phone|opera mini|windows phone/i', $userAgent) === 1;
}

$hasValidFingerprint = is_string($mtlsFingerprint) && preg_match('/^[A-Fa-f0-9]{64}$/', $mtlsFingerprint) === 1;

if ($mtlsRequired && !$hasValidFingerprint) {
    header('Content-Type: text/plain; charset=utf-8', true, 403);
    echo 'Client certificate required for admin access.';
    exit;
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
