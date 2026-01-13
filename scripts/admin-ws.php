#!/usr/bin/env php
<?php

declare(strict_types=1);

use App\Config;
use App\Database;
use App\Repositories\AdminEventRepository;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

$root = dirname(__DIR__);

if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

function logLine(string $message, bool $error = false): void
{
    $stream = $error ? STDERR : STDOUT;
    fwrite($stream, '[' . gmdate(DATE_ATOM) . '] ' . $message . PHP_EOL);
}

function normalizeBool(mixed $value): bool
{
    if (is_bool($value)) {
        return $value;
    }

    if (is_int($value)) {
        return $value === 1;
    }

    if (is_string($value)) {
        $normalized = strtolower(trim($value));
        return in_array($normalized, ['1', 'true', 'yes', 'on'], true);
    }

    return false;
}

function parseHttpRequest(string $raw): ?array
{
    $parts = explode("\r\n\r\n", $raw, 2);
    $headerBlock = $parts[0] ?? '';
    $lines = explode("\r\n", $headerBlock);
    if (!$lines) {
        return null;
    }

    $requestLine = array_shift($lines);
    if (!is_string($requestLine) || $requestLine === '') {
        return null;
    }

    $requestParts = explode(' ', $requestLine);
    if (count($requestParts) < 2) {
        return null;
    }

    $method = strtoupper(trim((string) $requestParts[0]));
    $target = trim((string) $requestParts[1]);

    $headers = [];
    foreach ($lines as $line) {
        if (!is_string($line) || $line === '') {
            continue;
        }
        $pos = strpos($line, ':');
        if ($pos === false) {
            continue;
        }
        $name = strtolower(trim(substr($line, 0, $pos)));
        $value = trim(substr($line, $pos + 1));
        if ($name !== '') {
            $headers[$name] = $value;
        }
    }

    return [
        'method' => $method,
        'target' => $target,
        'headers' => $headers,
    ];
}

function readHttpRequest($socket, int $timeoutSeconds = 2): ?string
{
    $buffer = '';
    $start = microtime(true);

    while (strpos($buffer, "\r\n\r\n") === false) {
        $chunk = fread($socket, 1024);
        if ($chunk === false) {
            break;
        }
        if ($chunk === '') {
            if ((microtime(true) - $start) >= $timeoutSeconds) {
                break;
            }
            usleep(10000);
            continue;
        }
        $buffer .= $chunk;
        if (strlen($buffer) > 16384) {
            break;
        }
    }

    return $buffer !== '' ? $buffer : null;
}

function mtlsSatisfiedFromHeaders(array $headers): bool
{
    $fingerprintRaw = $headers['x-mtls-fingerprint'] ?? ($headers['x-mtls-present'] ?? '');
    $fingerprint = preg_replace('/[^A-Fa-f0-9]/', '', (string) $fingerprintRaw);

    return is_string($fingerprint) && strlen($fingerprint) >= 64 && preg_match('/^[A-Fa-f0-9]+$/', $fingerprint) === 1;
}

function sendHttpResponse($socket, int $status, string $body, array $headers = []): void
{
    $statusText = match ($status) {
        101 => 'Switching Protocols',
        400 => 'Bad Request',
        401 => 'Unauthorized',
        403 => 'Forbidden',
        426 => 'Upgrade Required',
        default => 'OK',
    };
    $headerLines = "HTTP/1.1 {$status} {$statusText}\r\n";
    $headers['Content-Length'] = (string) strlen($body);
    foreach ($headers as $name => $value) {
        $headerLines .= $name . ': ' . $value . "\r\n";
    }
    $headerLines .= "\r\n";
    fwrite($socket, $headerLines . $body);
}

function encodeFrame(string $payload, int $opcode = 0x1): string
{
    $finAndOpcode = 0x80 | ($opcode & 0x0f);
    $frame = chr($finAndOpcode);
    $length = strlen($payload);

    if ($length <= 125) {
        $frame .= chr($length);
    } elseif ($length <= 65535) {
        $frame .= chr(126) . pack('n', $length);
    } else {
        $frame .= chr(127) . pack('NN', 0, $length);
    }

    return $frame . $payload;
}

function decodeFrames(string $buffer): array
{
    $frames = [];
    $offset = 0;
    $length = strlen($buffer);

    while ($length - $offset >= 2) {
        $first = ord($buffer[$offset]);
        $second = ord($buffer[$offset + 1]);
        $opcode = $first & 0x0f;
        $masked = ($second & 0x80) !== 0;
        $payloadLen = $second & 0x7f;
        $cursor = $offset + 2;

        if ($payloadLen === 126) {
            if ($length - $cursor < 2) {
                break;
            }
            $payloadLen = unpack('n', substr($buffer, $cursor, 2))[1];
            $cursor += 2;
        } elseif ($payloadLen === 127) {
            if ($length - $cursor < 8) {
                break;
            }
            $parts = unpack('N2', substr($buffer, $cursor, 8));
            $payloadLen = ($parts[1] << 32) + $parts[2];
            $cursor += 8;
        }

        $maskKey = '';
        if ($masked) {
            if ($length - $cursor < 4) {
                break;
            }
            $maskKey = substr($buffer, $cursor, 4);
            $cursor += 4;
        }

        if ($length - $cursor < $payloadLen) {
            break;
        }

        $payload = $payloadLen > 0 ? substr($buffer, $cursor, $payloadLen) : '';
        if ($masked && $maskKey !== '') {
            $unmasked = '';
            for ($i = 0; $i < $payloadLen; $i++) {
                $unmasked .= $payload[$i] ^ $maskKey[$i % 4];
            }
            $payload = $unmasked;
        }

        $frames[] = [
            'opcode' => $opcode,
            'payload' => $payload,
        ];

        $cursor += $payloadLen;
        $offset = $cursor;
    }

    return [$frames, substr($buffer, $offset)];
}

try {
    $dbConfig = [
        'driver' => Config::get('DB_DRIVER', 'mysql'),
        'host' => Config::get('DB_HOST', 'mysql'),
        'port' => (int) Config::get('DB_PORT', 3306),
        'database' => Config::get('DB_DATABASE', 'codex_auth'),
        'username' => Config::get('DB_USERNAME', 'codex'),
        'password' => Config::get('DB_PASSWORD', 'codex-pass'),
        'charset' => Config::get('DB_CHARSET', 'utf8mb4'),
    ];

    $database = new Database($dbConfig);
    $database->migrate();

    $events = new AdminEventRepository($database);

    $bind = Config::get('ADMIN_WS_BIND', '0.0.0.0:8091');
    if (!is_string($bind) || trim($bind) === '') {
        $bind = '0.0.0.0:8091';
    }
    $bind = trim($bind);

    $pollIntervalRaw = Config::get('ADMIN_WS_POLL_INTERVAL', 1);
    $pollInterval = is_numeric($pollIntervalRaw) ? (float) $pollIntervalRaw : 1.0;
    if ($pollInterval < 0.2) {
        $pollInterval = 0.2;
    }

    $pingIntervalRaw = Config::get('ADMIN_WS_PING_INTERVAL', 25);
    $pingInterval = is_numeric($pingIntervalRaw) ? (int) $pingIntervalRaw : 25;
    if ($pingInterval < 5) {
        $pingInterval = 5;
    }

    $backlogRaw = Config::get('ADMIN_WS_BACKLOG_LIMIT', 200);
    $backlogLimit = is_numeric($backlogRaw) ? (int) $backlogRaw : 200;
    if ($backlogLimit < 1) {
        $backlogLimit = 1;
    } elseif ($backlogLimit > 500) {
        $backlogLimit = 500;
    }

    $adminMode = Config::get('ADMIN_ACCESS_MODE', 'mtls');
    $requireMtls = strtolower(trim((string) $adminMode)) !== 'none';
    $enabledFlag = Config::get('ADMIN_WS_ENABLED', '0');
    if (normalizeBool($enabledFlag) !== true) {
        logLine('ADMIN_WS_ENABLED is off; /admin/ws/info will report disabled until enabled.');
    }

    $server = stream_socket_server('tcp://' . $bind, $errno, $errstr);
    if ($server === false) {
        logLine("Failed to bind {$bind}: {$errstr} ({$errno})", true);
        exit(1);
    }

    stream_set_blocking($server, false);
    logLine("Admin WS server listening on {$bind}");

    $clients = [];
    $lastPollAt = microtime(true);
    $lastPingAt = time();
    $lastEventId = $events->latestId();

    while (true) {
        $read = [$server];
        foreach ($clients as $client) {
            $read[] = $client['socket'];
        }

        $write = null;
        $except = null;
        $timeoutSec = 1;
        $timeoutMicro = 0;
        @stream_select($read, $write, $except, $timeoutSec, $timeoutMicro);

        foreach ($read as $socket) {
            if ($socket === $server) {
                $client = @stream_socket_accept($server, 0);
                if ($client === false) {
                    continue;
                }

                stream_set_timeout($client, 2);
                stream_set_blocking($client, true);
                $raw = readHttpRequest($client, 2);
                if ($raw === null) {
                    fclose($client);
                    continue;
                }

                $request = parseHttpRequest($raw);
                if ($request === null || ($request['method'] ?? '') !== 'GET') {
                    sendHttpResponse($client, 400, 'Bad request');
                    fclose($client);
                    continue;
                }

                $headers = $request['headers'] ?? [];
                if ($requireMtls && !mtlsSatisfiedFromHeaders($headers)) {
                    sendHttpResponse($client, 403, 'Client certificate required for admin access');
                    fclose($client);
                    continue;
                }

                $upgrade = strtolower((string) ($headers['upgrade'] ?? ''));
                $connection = strtolower((string) ($headers['connection'] ?? ''));
                $wsKey = $headers['sec-websocket-key'] ?? null;
                if ($upgrade !== 'websocket' || !str_contains($connection, 'upgrade') || !is_string($wsKey) || $wsKey === '') {
                    sendHttpResponse($client, 426, 'Upgrade required', [
                        'Upgrade' => 'websocket',
                        'Connection' => 'Upgrade',
                    ]);
                    fclose($client);
                    continue;
                }

                $accept = base64_encode(sha1($wsKey . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', true));
                $responseHeaders = [
                    'Upgrade' => 'websocket',
                    'Connection' => 'Upgrade',
                    'Sec-WebSocket-Accept' => $accept,
                ];
                $headerLines = "HTTP/1.1 101 Switching Protocols\r\n";
                foreach ($responseHeaders as $name => $value) {
                    $headerLines .= $name . ': ' . $value . "\r\n";
                }
                $headerLines .= "\r\n";
                fwrite($client, $headerLines);

                stream_set_blocking($client, false);

                $target = (string) ($request['target'] ?? '/');
                $query = parse_url($target, PHP_URL_QUERY) ?? '';
                $params = [];
                if (is_string($query) && $query !== '') {
                    parse_str($query, $params);
                }

                $since = 0;
                if (isset($params['since']) && is_scalar($params['since'])) {
                    $sinceValue = (int) $params['since'];
                    $since = $sinceValue > 0 ? $sinceValue : 0;
                }

                $clientId = (int) $client;
                $clients[$clientId] = [
                    'socket' => $client,
                    'buffer' => '',
                    'last_pong' => time(),
                    'last_sent' => $since,
                ];

                $helloPayload = [
                    'kind' => 'hello',
                    'server_time' => gmdate(DATE_ATOM),
                    'last_event_id' => $lastEventId,
                ];
                fwrite($client, encodeFrame(json_encode($helloPayload, JSON_UNESCAPED_SLASHES)));

                if ($since > 0 && $since < $lastEventId) {
                    $backlog = $events->sinceId($since, $backlogLimit);
                    foreach ($backlog as $event) {
                        $payload = [
                            'kind' => 'event',
                            'event' => $event,
                        ];
                        fwrite($client, encodeFrame(json_encode($payload, JSON_UNESCAPED_SLASHES)));
                        $clients[$clientId]['last_sent'] = max($clients[$clientId]['last_sent'], (int) $event['id']);
                    }
                    if (count($backlog) >= $backlogLimit) {
                        $info = [
                            'kind' => 'info',
                            'message' => 'backlog truncated',
                            'last_event_id' => $clients[$clientId]['last_sent'],
                        ];
                        fwrite($client, encodeFrame(json_encode($info, JSON_UNESCAPED_SLASHES)));
                    }
                }

                continue;
            }

            $clientId = (int) $socket;
            if (!isset($clients[$clientId])) {
                continue;
            }

            $data = @fread($socket, 8192);
            if ($data === '' || $data === false) {
                if (feof($socket)) {
                    fclose($socket);
                    unset($clients[$clientId]);
                }
                continue;
            }

            $clients[$clientId]['buffer'] .= $data;
            [$frames, $remaining] = decodeFrames($clients[$clientId]['buffer']);
            $clients[$clientId]['buffer'] = $remaining;

            foreach ($frames as $frame) {
                $opcode = $frame['opcode'] ?? null;
                $payload = $frame['payload'] ?? '';

                if ($opcode === 0x8) {
                    fwrite($socket, encodeFrame('', 0x8));
                    fclose($socket);
                    unset($clients[$clientId]);
                    break;
                }
                if ($opcode === 0x9) {
                    fwrite($socket, encodeFrame($payload, 0xA));
                    continue;
                }
                if ($opcode === 0xA) {
                    $clients[$clientId]['last_pong'] = time();
                    continue;
                }
            }
        }

        $now = microtime(true);
        if (($now - $lastPollAt) >= $pollInterval) {
            $lastPollAt = $now;
            $eventsBatch = $events->sinceId($lastEventId, 200);
            if ($eventsBatch) {
                foreach ($eventsBatch as $event) {
                    $payload = json_encode([
                        'kind' => 'event',
                        'event' => $event,
                    ], JSON_UNESCAPED_SLASHES);
                    $frame = encodeFrame($payload);
                    foreach ($clients as $id => $client) {
                        $writeResult = @fwrite($client['socket'], $frame);
                        if ($writeResult === false) {
                            fclose($client['socket']);
                            unset($clients[$id]);
                            continue;
                        }
                        $clients[$id]['last_sent'] = max($clients[$id]['last_sent'], (int) $event['id']);
                    }
                    $lastEventId = max($lastEventId, (int) $event['id']);
                }
            }
        }

        $nowSec = time();
        if (($nowSec - $lastPingAt) >= $pingInterval) {
            $lastPingAt = $nowSec;
            $pingFrame = encodeFrame('', 0x9);
            foreach ($clients as $id => $client) {
                $writeResult = @fwrite($client['socket'], $pingFrame);
                if ($writeResult === false) {
                    fclose($client['socket']);
                    unset($clients[$id]);
                    continue;
                }
                if (($nowSec - $client['last_pong']) > ($pingInterval * 2)) {
                    fclose($client['socket']);
                    unset($clients[$id]);
                }
            }
        }
    }
} catch (Throwable $exception) {
    logLine('Admin WS server failed: ' . $exception->getMessage(), true);
    exit(1);
}
