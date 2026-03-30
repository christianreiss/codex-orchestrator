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

    public function testSkillSummarizerPostsAuthSlugManifestAndTimeoutSeconds(): void
    {
        $tmpDir = sys_get_temp_dir() . '/runner-skill-summary-' . uniqid('', true);
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
        'latency_ms' => 2,
        'reachable' => true,
        'codex_version' => 'test',
        'summary' => 'Handles deployments safely.',
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

            $result = $verifier->summarizeSkill(
                'deploy',
                "# Deploy\nUse this skill to roll out safely.\n",
                ['tokens' => ['access_token' => 'sk-test-1234567890abcdefghijklmnop']],
                4.5
            );

            self::assertSame('ok', $result['status'] ?? null);
            self::assertSame('Handles deployments safely.', $result['summary'] ?? null);
            self::assertFileExists($requestPath);

            $payload = json_decode((string) file_get_contents($requestPath), true, flags: JSON_THROW_ON_ERROR);

            self::assertSame(['auth_json', 'slug', 'manifest', 'timeout_seconds'], array_keys($payload));
            self::assertSame('deploy', $payload['slug']);
            self::assertStringContainsString('Use this skill', $payload['manifest']);
            self::assertSame(4.5, $payload['timeout_seconds']);
            self::assertSame(
                'sk-test-1234567890abcdefghijklmnop',
                $payload['auth_json']['tokens']['access_token'] ?? null
            );
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

    public function testSkillGeneratorPostsAuthPromptSlugHintAndTimeoutSeconds(): void
    {
        $tmpDir = sys_get_temp_dir() . '/runner-skill-generate-' . uniqid('', true);
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
        'latency_ms' => 3,
        'reachable' => true,
        'codex_version' => 'test',
        'slug' => 'incident-handoff',
        'display_name' => 'Incident handoff',
        'description' => 'Guides a clean operator handoff.',
        'tags' => ['incident', 'handoff'],
        'what' => 'Summarize the issue and handoff state.',
        'when' => 'Use when ownership changes.',
        'steps' => '1. Gather context.',
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

            $result = $verifier->generateSkillDraft(
                'Create a handoff skill for incidents.',
                ['tokens' => ['access_token' => 'sk-test-1234567890abcdefghijklmnop']],
                'incident-handoff',
                5.5
            );

            self::assertSame('ok', $result['status'] ?? null);
            self::assertSame('incident-handoff', $result['slug'] ?? null);
            self::assertFileExists($requestPath);

            $payload = json_decode((string) file_get_contents($requestPath), true, flags: JSON_THROW_ON_ERROR);

            self::assertSame(['auth_json', 'prompt', 'timeout_seconds', 'slug_hint'], array_keys($payload));
            self::assertSame('Create a handoff skill for incidents.', $payload['prompt']);
            self::assertSame('incident-handoff', $payload['slug_hint']);
            self::assertSame(5.5, $payload['timeout_seconds']);
            self::assertSame(
                'sk-test-1234567890abcdefghijklmnop',
                $payload['auth_json']['tokens']['access_token'] ?? null
            );
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

    public function testMemorySummarizerPostsAuthKeyContentAndTimeoutSeconds(): void
    {
        $tmpDir = sys_get_temp_dir() . '/runner-memory-summary-' . uniqid('', true);
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
        'latency_ms' => 4,
        'reachable' => true,
        'codex_version' => 'test',
        'summary' => 'Captures host-specific deployment notes.',
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

            $result = $verifier->summarizeMemory(
                'deploy.notes',
                "Remember to drain the queue before rollout.\n",
                ['tokens' => ['access_token' => 'sk-test-1234567890abcdefghijklmnop']],
                6.5
            );

            self::assertSame('ok', $result['status'] ?? null);
            self::assertSame('Captures host-specific deployment notes.', $result['summary'] ?? null);
            self::assertFileExists($requestPath);

            $payload = json_decode((string) file_get_contents($requestPath), true, flags: JSON_THROW_ON_ERROR);

            self::assertSame(['auth_json', 'memory_key', 'content', 'timeout_seconds'], array_keys($payload));
            self::assertSame('deploy.notes', $payload['memory_key']);
            self::assertStringContainsString('drain the queue', $payload['content']);
            self::assertSame(6.5, $payload['timeout_seconds']);
            self::assertSame(
                'sk-test-1234567890abcdefghijklmnop',
                $payload['auth_json']['tokens']['access_token'] ?? null
            );
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
