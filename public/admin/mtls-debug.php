<?php
$h = function_exists('getallheaders') ? getallheaders() : [];
$v = $h['X-Mtls-Fingerprint'] ?? ($h['X-MTLS-FINGERPRINT'] ?? '');
$normalized = is_string($v) ? preg_replace('/[^A-Fa-f0-9]/', '', $v) : '';
header('Content-Type: application/json');
echo json_encode([
  'value' => $v,
  'len' => strlen($v),
  'hex64' => preg_match('/^[A-Fa-f0-9]{64}$/', $v) === 1,
  'normalized' => $normalized,
  'normalized_len' => is_string($normalized) ? strlen($normalized) : 0,
  'normalized_hex64' => is_string($normalized) ? (preg_match('/^[A-Fa-f0-9]{64}$/', $normalized) === 1) : false,
  'headers' => $h,
], JSON_PRETTY_PRINT);
