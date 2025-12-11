<?php

/**
 * Lightweight passkey smoke tester.
 *
 * - Hits /admin/passkey/auth/options and then /admin/passkey/auth/finish with a fake assertion.
 * - Purpose: exercise routing + validator wiring inside the container, not to succeed cryptographically.
 *
 * Usage:
 *   php scripts/passkey-smoke.php http://localhost:8080
 *   BASE_URL=http://localhost:8080 php scripts/passkey-smoke.php
 *
 * Admin auth:
 *   - Set BYPASS_MTLS=1 to send X-Bypass-Mtls: 1 (only relevant when admin mode is passkey-only).
 *
 * Exit codes:
 *   0  options+finish both reachable (finish may still reject signature, that's fine)
 *   1  options call failed or missing challenge/id
 *   2  finish call failed (non-200)
 */

$base = $argv[1] ?? getenv('BASE_URL') ?? 'http://localhost:8080';

function postJson(string $url, array $body, array $headers = []): array
{
    $payload = json_encode($body, JSON_UNESCAPED_SLASHES);
    $headerLines = array_merge([
        'Content-Type: application/json',
        'Content-Length: ' . strlen($payload),
    ], $headers);

    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headerLines),
            'content' => $payload,
            'ignore_errors' => true, // fetch body even on 4xx/5xx
        ],
    ]);
    $resp = file_get_contents($url, false, $context);
    $status = 0;
    if (isset($http_response_header) && preg_match('#HTTP/\\d\.\\d\\s+(\\d{3})#', $http_response_header[0], $m)) {
        $status = (int) $m[1];
    }
    $err = $resp === false ? 'stream failed' : '';
    return [$status, $resp, $err];
}

function pretty(string $label, int $status, string|false $body, string $err): void
{
    echo "== {$label} ==\n";
    echo "HTTP {$status}\n";
    if ($err) {
        echo "error: {$err}\n";
    }
    echo ($body === false ? '<no body>' : $body) . "\n\n";
}

$headers = [];
$mode = getenv('ADMIN_ACCESS_MODE') ?: 'mtls_and_passkey';
if ($mode === 'passkey_only' && getenv('BYPASS_MTLS') === '1') {
    $headers[] = 'X-Bypass-Mtls: 1';
}

[$s1, $r1, $e1] = postJson("{$base}/admin/passkey/auth/options", [], $headers);
pretty('auth/options', $s1, $r1, $e1);

$data = json_decode((string) $r1, true);
if (!is_array($data) || ($data['status'] ?? '') !== 'ok') {
    fwrite(STDERR, "auth/options failed or malformed\n");
    exit(1);
}

$challenge = $data['data']['challenge'] ?? null;
$credId = $data['data']['allowCredentials'][0]['id'] ?? null;
if (!$challenge || !$credId) {
    fwrite(STDERR, "Missing challenge or credential id in options\n");
    exit(1);
}

// Intentionally bogus assertion: exercises server-side wiring and error reporting end-to-end.
$fakeAssertion = [
    'id' => $credId,
    'rawId' => $credId,
    'type' => 'public-key',
    'response' => [
        'authenticatorData' => $challenge,
        'clientDataJSON' => $challenge,
        'signature' => $challenge,
        'userHandle' => null,
    ],
    'clientExtensionResults' => new \stdClass(),
];

[$s2, $r2, $e2] = postJson("{$base}/admin/passkey/auth/finish", $fakeAssertion, $headers);
pretty('auth/finish', $s2, $r2, $e2);

exit($s2 === 200 ? 0 : 2);
