<?php

$mtlsPresent = $_SERVER['HTTP_X_MTLS_PRESENT'] ?? '';
$mtlsFingerprint = $_SERVER['HTTP_X_MTLS_FINGERPRINT'] ?? '';
$mtlsSubject = $_SERVER['HTTP_X_MTLS_SUBJECT'] ?? '';
$mtlsIssuer = $_SERVER['HTTP_X_MTLS_ISSUER'] ?? '';
$remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
$userAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';

error_log(sprintf(
    'admin access mtls_present=%s fingerprint=%s subject="%s" issuer="%s" ip=%s ua="%s"',
    $mtlsPresent === '' ? 'absent' : $mtlsPresent,
    $mtlsFingerprint === '' ? 'absent' : $mtlsFingerprint,
    $mtlsSubject,
    $mtlsIssuer,
    $remoteAddr,
    $userAgent
));

$hasValidFingerprint = is_string($mtlsFingerprint) && preg_match('/^[A-Fa-f0-9]{64}$/', $mtlsFingerprint) === 1;

if (!$hasValidFingerprint) {
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

header('Content-Type: text/html; charset=utf-8');
readfile($html);
