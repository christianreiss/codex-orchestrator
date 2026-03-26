<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperUsageUploadTest extends TestCase
{
    /**
     * @var list<string>
     */
    private array $cleanupPaths = [];

    /**
     * @var list<resource>
     */
    private array $serverProcesses = [];

    public function testUsageUploadTimeoutDoesNotBlockWrapperExitForLong(): void
    {
        $port = $this->allocateTcpPort();
        $hitLog = $this->createTempFile('cdx-usage-hit-log-', '');
        $router = $this->createTempFile(
            'cdx-usage-router-',
            sprintf(
                <<<'PHP'
<?php
file_put_contents(%s, "hit\n", FILE_APPEND);
if (($_SERVER['REQUEST_URI'] ?? '') === '/usage') {
    sleep(10);
    header('Content-Type: application/json');
    echo json_encode(['data' => ['recorded' => true, 'cost' => 1.23]]);
    return true;
}
http_response_code(404);
echo "missing";
return true;
PHP,
                var_export($hitLog, true)
            )
        );
        $this->startPhpServer($port, $router);

        $fragmentPath = realpath(__DIR__ . '/../bin/cdx.d/03-sync-50-usage.sh');
        self::assertIsString($fragmentPath, 'Expected to find usage fragment.');

        $payload = json_encode([
            'usages' => [[
                'total' => 123,
                'input' => 100,
                'output' => 23,
                'line' => 'Token usage: total=123 input=100 output=23',
            ]],
        ], JSON_UNESCAPED_SLASHES);
        self::assertIsString($payload);

        $bashScript = implode("\n", [
            'set -euo pipefail',
            'source ' . escapeshellarg($fragmentPath),
            'CODEX_SYNC_BASE_URL=' . escapeshellarg(sprintf('http://127.0.0.1:%d', $port)),
            'CODEX_SYNC_API_KEY=test-key',
            "CODEX_SYNC_CA_FILE=''",
            'post_token_usage_payload ' . escapeshellarg($payload) . ' || true',
            'printf "result=%s\nreason=%s\n" "$USAGE_PUSH_RESULT" "$USAGE_PUSH_REASON"',
        ]);
        $command = 'bash -lc ' . escapeshellarg($bashScript);

        $start = microtime(true);
        $output = [];
        $status = 0;
        exec($command, $output, $status);
        $elapsed = microtime(true) - $start;

        self::assertSame(0, $status, 'Expected wrapper usage upload shell to exit cleanly.');
        self::assertLessThan(
            5.0,
            $elapsed,
            sprintf('Expected timed-out usage upload to stay best-effort; took %.3fs.', $elapsed)
        );

        $joined = implode("\n", $output);
        self::assertStringContainsString('result=failed', $joined);
        self::assertStringContainsString('reason=request timed out', $joined);

        $hits = file_get_contents($hitLog);
        self::assertIsString($hits);
        self::assertSame(1, substr_count($hits, "hit\n"), 'Timed-out upload should not retry fallback payloads.');
    }

    protected function tearDown(): void
    {
        foreach ($this->serverProcesses as $process) {
            @proc_terminate($process);
            @proc_close($process);
        }
        $this->serverProcesses = [];

        foreach (array_reverse($this->cleanupPaths) as $path) {
            if (is_file($path) || is_link($path)) {
                @unlink($path);
            }
        }
        $this->cleanupPaths = [];
    }

    private function allocateTcpPort(): int
    {
        $server = @stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        self::assertNotFalse($server, sprintf('Expected to allocate a local TCP port: %s', $errstr));

        $name = stream_socket_get_name($server, false);
        fclose($server);

        self::assertIsString($name);
        self::assertMatchesRegularExpression('/:(\d+)$/', $name);
        preg_match('/:(\d+)$/', $name, $matches);

        return (int) ($matches[1] ?? 0);
    }

    private function createTempFile(string $prefix, string $content): string
    {
        $path = tempnam(sys_get_temp_dir(), $prefix);
        self::assertNotFalse($path);
        $this->cleanupPaths[] = $path;
        self::assertNotFalse(file_put_contents($path, $content));
        return $path;
    }

    private function startPhpServer(int $port, string $routerPath): void
    {
        $stdout = $this->createTempFile('cdx-usage-server-out-', '');
        $stderr = $this->createTempFile('cdx-usage-server-err-', '');

        $command = sprintf('php -S 127.0.0.1:%d %s', $port, escapeshellarg($routerPath));
        $process = proc_open(
            $command,
            [
                0 => ['pipe', 'r'],
                1 => ['file', $stdout, 'a'],
                2 => ['file', $stderr, 'a'],
            ],
            $pipes,
            dirname(__DIR__)
        );

        self::assertIsResource($process, 'Expected to start local PHP server for usage timeout test.');
        if (isset($pipes[0]) && is_resource($pipes[0])) {
            fclose($pipes[0]);
        }
        $this->serverProcesses[] = $process;

        $deadline = microtime(true) + 5.0;
        do {
            $conn = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2);
            if (is_resource($conn)) {
                fclose($conn);
                return;
            }
            usleep(100_000);
        } while (microtime(true) < $deadline);

        $stderrText = file_get_contents($stderr);
        self::fail('Local PHP server did not start in time: ' . ($stderrText ?: 'no stderr'));
    }
}
