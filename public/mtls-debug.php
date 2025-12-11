<?php
header('Content-Type: application/json');
echo json_encode([
  'server' => $_SERVER,
  'headers' => getallheaders(),
], JSON_PRETTY_PRINT);
