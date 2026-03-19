<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperUsageParsingTest extends TestCase
{
    public function testWrapperParsesLegacyTokenUsageLines(): void
    {
        $payload = $this->parseUsagePayload(<<<'LOG'
OpenAI Codex v0.113.0
codex
hi
Token usage: total=100 input=70 output=30
LOG);

        $this->assertIsArray($payload);
        $this->assertCount(1, $payload['usages'] ?? []);
        $this->assertSame(100, $payload['usages'][0]['total'] ?? null);
        $this->assertSame(70, $payload['usages'][0]['input'] ?? null);
        $this->assertSame(30, $payload['usages'][0]['output'] ?? null);
    }

    public function testWrapperPrefersStructuredUsageFromSessionJsonl(): void
    {
        $home = $this->createTempDir('home');
        $sessionId = '019ce8c7-bade-79c0-a972-37a807af786e';
        $sessionDir = $home . '/.codex/sessions/2026/03/13';
        mkdir($sessionDir, 0777, true);

        $sessionPath = $sessionDir . '/rollout-2026-03-13T20-58-49-' . $sessionId . '.jsonl';
        $this->registerFileForCleanup($sessionPath);
        $this->assertNotFalse(file_put_contents($sessionPath, implode("\n", [
            json_encode([
                'type' => 'event_msg',
                'payload' => [
                    'type' => 'token_count',
                    'info' => [
                        'last_token_usage' => [
                            'input_tokens' => 16378,
                            'cached_input_tokens' => 5504,
                            'output_tokens' => 33,
                            'reasoning_output_tokens' => 26,
                            'total_tokens' => 16411,
                        ],
                    ],
                ],
            ], JSON_UNESCAPED_SLASHES),
            '',
        ])));

        $payload = $this->parseUsagePayload(<<<LOG
OpenAI Codex v0.114.0 (research preview)
--------
session id: {$sessionId}
user
Reply with exactly: hi
codex
hi
tokens used
13,841
hi
LOG, $home);

        $this->assertIsArray($payload);
        $this->assertCount(1, $payload['usages'] ?? []);
        $this->assertSame(16411, $payload['usages'][0]['total'] ?? null);
        $this->assertSame(16378, $payload['usages'][0]['input'] ?? null);
        $this->assertSame(5504, $payload['usages'][0]['cached'] ?? null);
        $this->assertSame(33, $payload['usages'][0]['output'] ?? null);
        $this->assertSame(26, $payload['usages'][0]['reasoning'] ?? null);
        $this->assertStringContainsString('Token usage:', (string) ($payload['usages'][0]['line'] ?? ''));
    }

    public function testWrapperFallsBackToCurrentTokensUsedFooter(): void
    {
        $payload = $this->parseUsagePayload(<<<'LOG'
OpenAI Codex v0.114.0 (research preview)
--------
user
Reply with exactly: hi
codex
hi
tokens used
13,841
hi
LOG);

        $this->assertIsArray($payload);
        $this->assertCount(1, $payload['usages'] ?? []);
        $this->assertSame(13841, $payload['usages'][0]['total'] ?? null);
        $this->assertStringContainsString('tokens used', strtolower((string) ($payload['usages'][0]['line'] ?? '')));
    }

    protected function tearDown(): void
    {
        foreach (array_reverse($this->cleanupPaths ?? []) as $path) {
            $this->removePath($path);
        }
        $this->cleanupPaths = [];
    }

    /**
     * @var list<string>
     */
    private array $cleanupPaths = [];

    /**
     * @return array<string, mixed>|null
     */
    private function parseUsagePayload(string $capturedOutput, ?string $home = null): ?array
    {
        $fragment = @file_get_contents(__DIR__ . '/../bin/cdx.d/03-sync-50-usage.sh');
        self::assertIsString($fragment, 'Expected to be able to read usage parser fragment.');

        $startMarker = "python3 - \"\$log_path\" <<'PY'\n";
        $start = strpos($fragment, $startMarker);
        self::assertNotFalse($start, 'Expected to find the embedded usage parser start.');
        $start += strlen($startMarker);

        $end = strpos($fragment, "\nPY\n}", $start);
        self::assertNotFalse($end, 'Expected to find the embedded usage parser end.');

        $pythonFile = tempnam(sys_get_temp_dir(), 'cdx-usage-parser-');
        $logFile = tempnam(sys_get_temp_dir(), 'cdx-usage-log-');
        self::assertNotFalse($pythonFile);
        self::assertNotFalse($logFile);
        $runtimeHome = $home ?? $this->createTempDir('home');

        try {
            self::assertNotFalse(file_put_contents($pythonFile, substr($fragment, $start, $end - $start)));
            self::assertNotFalse(file_put_contents($logFile, $capturedOutput));

            $output = [];
            $status = 0;
            $command = sprintf(
                'HOME=%s python3 %s %s',
                escapeshellarg($runtimeHome),
                escapeshellarg($pythonFile),
                escapeshellarg($logFile)
            );
            exec($command, $output, $status);

            self::assertSame(0, $status, 'Expected usage parser to exit successfully.');

            $json = trim(implode("\n", $output));
            self::assertNotSame('', $json, 'Expected usage parser to emit a payload.');

            $decoded = json_decode($json, true);
            self::assertIsArray($decoded, 'Expected usage parser to return JSON.');

            return $decoded;
        } finally {
            @unlink($pythonFile);
            @unlink($logFile);
        }
    }

    private function createTempDir(string $prefix): string
    {
        $path = sys_get_temp_dir() . '/cdx-usage-test-' . $prefix . '-' . bin2hex(random_bytes(6));
        mkdir($path, 0777, true);
        $this->cleanupPaths[] = $path;
        return $path;
    }

    private function registerFileForCleanup(string $path): void
    {
        $this->cleanupPaths[] = $path;
    }

    private function removePath(string $path): void
    {
        if (is_file($path) || is_link($path)) {
            @unlink($path);
            return;
        }
        if (!is_dir($path)) {
            return;
        }

        $entries = scandir($path);
        if ($entries !== false) {
            foreach ($entries as $entry) {
                if ($entry === '.' || $entry === '..') {
                    continue;
                }
                $this->removePath($path . DIRECTORY_SEPARATOR . $entry);
            }
        }

        @rmdir($path);
    }
}
