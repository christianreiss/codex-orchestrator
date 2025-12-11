<?php
$h = function_exists('getallheaders') ? getallheaders() : [];
$v = $h['X-Mtls-Fingerprint'] ?? ($h['X-MTLS-FINGERPRINT'] ?? '');
header('Content-Type: application/json');
echo json_encode([
  'value' => $v,
  'len' => strlen($v),
  'hex64' => preg_match('/^[A-Fa-f0-9]{64}$/', $v) === 1,
  'headers' => $h,
], JSON_PRETTY_PRINT);
