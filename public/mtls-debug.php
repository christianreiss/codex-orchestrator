<?php

declare(strict_types=1);

use App\Config;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

// Ensure errors do not leak HTML into shell outputs.
ini_set('display_errors', '0');
ini_set('html_errors', '0');

$root = dirname(__DIR__);
if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

$debugRaw = Config::get('CODEX_DEBUG', '0');
$debugEnabled = false;
if (is_bool($debugRaw)) {
    $debugEnabled = $debugRaw;
} elseif (is_int($debugRaw)) {
    $debugEnabled = $debugRaw === 1;
} else {
    $value = strtolower(trim((string) $debugRaw));
    $debugEnabled = in_array($value, ['1', 'true', 'yes', 'on'], true);
}

if (!$debugEnabled) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo "Not Found\n";
    exit;
}

header('Content-Type: application/json');
$headers = [];
if (function_exists('getallheaders')) {
    $headers = getallheaders();
} else {
    foreach ($_SERVER as $key => $value) {
        if (!is_string($key) || !str_starts_with($key, 'HTTP_')) {
            continue;
        }
        $name = str_replace('_', '-', strtolower(substr($key, 5)));
        $headers[$name] = $value;
    }
}
echo json_encode([
    'server' => $_SERVER,
    'headers' => $headers,
], JSON_PRETTY_PRINT);
