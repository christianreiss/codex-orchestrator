<?php

declare(strict_types=1);

use App\Support\SeedAuthScriptBuilder;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class SeedAuthScriptBuilderTest extends TestCase
{
    public function testTemplateTargetsSeedEndpoint(): void
    {
        $script = SeedAuthScriptBuilder::build('https://codex.test', '11111111-2222-3333-4444-555555555555');

        $this->assertStringContainsString('/seed/auth/11111111-2222-3333-4444-555555555555', $script);
        $this->assertStringContainsString("curl -sS -w '%{http_code}'", $script);
        $this->assertStringContainsString('auth.json', $script);
    }

    public function testClaudeTemplateTargetsClaudeCredentials(): void
    {
        $script = SeedAuthScriptBuilder::build('https://codex.test', '11111111-2222-3333-4444-555555555555', 'claude');

        self::assertStringContainsString('ENGINE="claude"', $script);
        self::assertStringContainsString('.claude/.credentials.json', $script);
        self::assertStringContainsString('anthropic_api_key', $script);
    }

    public function testScriptAddsLastRefreshForPlainCodexAuth(): void
    {
        $tmp = $this->makeSeedScriptFixture();
        try {
            file_put_contents($tmp['home'] . '/.codex/auth.json', json_encode([
                'tokens' => [
                    'access_token' => 'sk-test-seed-token-abcdefghijklmnopqrstuvwxyz',
                ],
            ], JSON_UNESCAPED_SLASHES));

            file_put_contents($tmp['bin'] . '/curl', <<<'SH'
#!/usr/bin/env bash
set -e
out=""
data=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    --data-binary)
      data="$2"
      shift 2
      ;;
    -w)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cp "${data#@}" "${CAPTURE_PATH}"
printf '{"status":"ok"}' > "$out"
printf '200'
SH);
            chmod($tmp['bin'] . '/curl', 0755);

            $output = [];
            $status = $this->runSeedScript($tmp, $output);

            self::assertSame(0, $status, implode("\n", $output));
            $captured = json_decode((string) file_get_contents($tmp['capture']), true);
            self::assertIsArray($captured);
            self::assertArrayHasKey('last_refresh', $captured);
            self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', $captured['last_refresh']);
            self::assertSame('sk-test-seed-token-abcdefghijklmnopqrstuvwxyz', $captured['tokens']['access_token'] ?? null);
        } finally {
            $this->removeTree($tmp['root']);
        }
    }

    public function testScriptAddsLastRefreshForClaudeOauthCredentials(): void
    {
        $tmp = $this->makeSeedScriptFixture('claude');
        try {
            mkdir($tmp['home'] . '/.claude');
            file_put_contents($tmp['home'] . '/.claude/.credentials.json', json_encode([
                'claudeAiOauth' => [
                    'accessToken' => 'sk-ant-oat01-seed-token-abcdefghijklmnopqrstuvwxyz',
                    'refreshToken' => 'refresh-token-value',
                ],
            ], JSON_UNESCAPED_SLASHES));

            file_put_contents($tmp['bin'] . '/curl', <<<'SH'
#!/usr/bin/env bash
set -e
out=""
data=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    --data-binary)
      data="$2"
      shift 2
      ;;
    -w)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cp "${data#@}" "${CAPTURE_PATH}"
printf '{"status":"ok"}' > "$out"
printf '200'
SH);
            chmod($tmp['bin'] . '/curl', 0755);

            $output = [];
            $status = $this->runSeedScript($tmp, $output);

            self::assertSame(0, $status, implode("\n", $output));
            $captured = json_decode((string) file_get_contents($tmp['capture']), true);
            self::assertIsArray($captured);
            self::assertArrayHasKey('last_refresh', $captured);
            self::assertSame(
                'sk-ant-oat01-seed-token-abcdefghijklmnopqrstuvwxyz',
                $captured['claudeAiOauth']['accessToken'] ?? null
            );
        } finally {
            $this->removeTree($tmp['root']);
        }
    }

    public function testScriptPrintsServerErrorBodyOnHttpFailure(): void
    {
        $tmp = $this->makeSeedScriptFixture();
        try {
            file_put_contents($tmp['home'] . '/.codex/auth.json', json_encode([
                'last_refresh' => '2026-04-19T00:00:00Z',
                'tokens' => [
                    'access_token' => 'sk-test-seed-token-abcdefghijklmnopqrstuvwxyz',
                ],
            ], JSON_UNESCAPED_SLASHES));

            file_put_contents($tmp['bin'] . '/curl', <<<'SH'
#!/usr/bin/env bash
set -e
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    -w)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
printf '{"status":"error","message":"Validation failed","errors":{"auth.last_refresh":["last_refresh is required"]}}' > "$out"
printf '422'
SH);
            chmod($tmp['bin'] . '/curl', 0755);

            $output = [];
            $status = $this->runSeedScript($tmp, $output);

            self::assertSame(1, $status);
            $joined = implode("\n", $output);
            self::assertStringContainsString('Upload failed (HTTP 422).', $joined);
            self::assertStringContainsString('"message":"Validation failed"', $joined);
            self::assertStringContainsString('"auth.last_refresh"', $joined);
        } finally {
            $this->removeTree($tmp['root']);
        }
    }

    /**
     * @return array{root:string,home:string,bin:string,script:string,capture:string}
     */
    private function makeSeedScriptFixture(string $engine = 'codex'): array
    {
        $root = (string) tempnam(sys_get_temp_dir(), 'seed-auth-script-');
        unlink($root);
        mkdir($root);
        mkdir($root . '/home');
        mkdir($root . '/home/.codex');
        mkdir($root . '/bin');

        $scriptPath = $root . '/seed.sh';
        file_put_contents($scriptPath, SeedAuthScriptBuilder::build('https://codex.test', '11111111-2222-3333-4444-555555555555', $engine));
        chmod($scriptPath, 0755);

        return [
            'root' => $root,
            'home' => $root . '/home',
            'bin' => $root . '/bin',
            'script' => $scriptPath,
            'capture' => $root . '/captured.json',
        ];
    }

    /**
     * @param array{home:string,bin:string,script:string,capture:string} $fixture
     * @param list<string> $output
     */
    private function runSeedScript(array $fixture, array &$output): int
    {
        $path = $fixture['bin'] . ':' . (string) getenv('PATH');
        $command = sprintf(
            'HOME=%s CAPTURE_PATH=%s PATH=%s bash %s 2>&1',
            escapeshellarg($fixture['home']),
            escapeshellarg($fixture['capture']),
            escapeshellarg($path),
            escapeshellarg($fixture['script'])
        );

        $status = 0;
        exec($command, $output, $status);

        return $status;
    }

    private function removeTree(string $path): void
    {
        if (!is_dir($path)) {
            return;
        }

        $items = scandir($path);
        if ($items === false) {
            return;
        }

        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $child = $path . '/' . $item;
            if (is_dir($child)) {
                $this->removeTree($child);
            } else {
                @unlink($child);
            }
        }
        @rmdir($path);
    }
}
