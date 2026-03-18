<?php

declare(strict_types=1);

use App\Services\RunnerVerifier;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class RunnerVerifierPayloadTest extends TestCase
{
    public function testVerifierPostsOnlyAuthJsonAndTimeoutSeconds(): void
    {
        $tmpDir = sys_get_temp_dir() . '/runner-verifier-' . uniqid('', true);
        self::assertTrue(mkdir($tmpDir, 0777, true) || is_dir($tmpDir));

        $routerPath = $tmpDir . '/router.php';
        $requestPath = $tmpDir . '/request.json';
        $stdoutPath = $tmpDir . '/server.out';
        $stderrPath = $tmpDir . '/server.err';

        file_put_contents($routerPath, <<<'PHP'
<?php
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    header('Content-Type: application/json');
    echo json_encode(['status' => 'ok']);
    return;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    file_put_contents(__DIR__ . '/request.json', file_get_contents('php://input'));
    header('Content-Type: application/json');
    echo json_encode([
        'status' => 'ok',
        'latency_ms' => 1,
        'reachable' => true,
        'codex_version' => 'test',
    ]);
    return;
}

http_response_code(404);
echo 'not found';
PHP);

        $server = $this->startPhpServer($tmpDir, $routerPath, $stdoutPath, $stderrPath);

        try {
            $verifier = new RunnerVerifier(
                'http://127.0.0.1:' . $server['port'] . '/verify',
                'https://unused.example',
                8.0
            );

            $result = $verifier->verify(
                ['tokens' => ['access_token' => 'sk-test-1234567890abcdefghijklmnop']],
                'https://ignored.example',
                3.5,
                ['api_key' => 'host-key', 'fqdn' => 'host.example']
            );

            self::assertSame('ok', $result['status'] ?? null);
            self::assertFileExists($requestPath);

            $payload = json_decode((string) file_get_contents($requestPath), true, flags: JSON_THROW_ON_ERROR);

            self::assertSame(['auth_json', 'timeout_seconds'], array_keys($payload));
            self::assertSame(3.5, $payload['timeout_seconds']);
            self::assertSame(
                'sk-test-1234567890abcdefghijklmnop',
                $payload['auth_json']['tokens']['access_token'] ?? null
            );
            self::assertArrayNotHasKey('base_url', $payload);
            self::assertArrayNotHasKey('api_key', $payload);
            self::assertArrayNotHasKey('fqdn', $payload);
        } finally {
            proc_terminate($server['process']);
            proc_close($server['process']);
            @unlink($routerPath);
            @unlink($requestPath);
            @unlink($stdoutPath);
            @unlink($stderrPath);
            @rmdir($tmpDir);
        }
    }

    /**
     * @return array{process:resource,port:int}
     */
    private function startPhpServer(string $workDir, string $routerPath, string $stdoutPath, string $stderrPath): array
    {
        $socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        self::assertNotFalse($socket, $errstr);
        $address = stream_socket_get_name($socket, false);
        self::assertIsString($address);
        $port = (int) substr((string) strrchr($address, ':'), 1);
        fclose($socket);

        $command = sprintf(
            '%s -S 127.0.0.1:%d %s',
            escapeshellarg(PHP_BINARY),
            $port,
            escapeshellarg($routerPath)
        );

        $process = proc_open(
            $command,
            [
                0 => ['pipe', 'r'],
                1 => ['file', $stdoutPath, 'a'],
                2 => ['file', $stderrPath, 'a'],
            ],
            $pipes,
            $workDir
        );

        self::assertIsResource($process);
        fclose($pipes[0]);

        $ready = false;
        for ($i = 0; $i < 50; $i++) {
            usleep(100000);
            $response = @file_get_contents('http://127.0.0.1:' . $port . '/verify');
            if ($response !== false) {
                $ready = true;
                break;
            }
        }

        if (!$ready) {
            proc_terminate($process);
            proc_close($process);
            self::fail('Failed to start local PHP test server');
        }

        return [
            'process' => $process,
            'port' => $port,
        ];
    }
}
