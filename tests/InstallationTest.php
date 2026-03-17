<?php

declare(strict_types=1);

use App\Support\Installation;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InstallationTest extends TestCase
{
    private string $tmpDir;
    private array $envBackup = [];

    protected function setUp(): void
    {
        $this->tmpDir = sys_get_temp_dir() . '/installation-test-' . bin2hex(random_bytes(4));
        mkdir($this->tmpDir, 0755, true);

        foreach (['INSTALLATION_ID'] as $key) {
            $this->envBackup[$key] = $_ENV[$key] ?? null;
            $this->envBackup['_SERVER_' . $key] = $_SERVER[$key] ?? null;
            unset($_ENV[$key], $_SERVER[$key]);
            putenv($key);
        }
    }

    protected function tearDown(): void
    {
        foreach (['INSTALLATION_ID'] as $key) {
            if ($this->envBackup[$key] !== null) {
                $_ENV[$key] = $this->envBackup[$key];
                $_SERVER[$key] = $this->envBackup['_SERVER_' . $key] ?? $this->envBackup[$key];
                putenv($key . '=' . $this->envBackup[$key]);
            } else {
                unset($_ENV[$key], $_SERVER[$key]);
                putenv($key);
            }
        }

        $envPath = $this->tmpDir . '/.env';
        if (file_exists($envPath)) {
            unlink($envPath);
        }
        if (is_dir($this->tmpDir)) {
            rmdir($this->tmpDir);
        }
    }

    public function testReturnsExistingEnvValue(): void
    {
        $_ENV['INSTALLATION_ID'] = 'env-id-123';
        putenv('INSTALLATION_ID=env-id-123');

        $result = Installation::ensure($this->tmpDir);
        $this->assertSame('env-id-123', $result);
    }

    public function testReadsFromExistingEnvFile(): void
    {
        file_put_contents($this->tmpDir . '/.env', "INSTALLATION_ID=file-id-456\n");

        $result = Installation::ensure($this->tmpDir);
        $this->assertSame('file-id-456', $result);
        $this->assertSame('file-id-456', $_ENV['INSTALLATION_ID']);
    }

    public function testGeneratesAndPersistsNewId(): void
    {
        file_put_contents($this->tmpDir . '/.env', "SOME_KEY=value\n");

        $result = Installation::ensure($this->tmpDir);

        $this->assertNotEmpty($result);
        $this->assertMatchesRegularExpression(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/',
            $result,
            'Should generate a valid UUID v4'
        );

        $contents = file_get_contents($this->tmpDir . '/.env');
        $this->assertStringContainsString('INSTALLATION_ID=' . $result, $contents);
    }

    public function testCreatesEnvFileWhenMissing(): void
    {
        $result = Installation::ensure($this->tmpDir);

        $this->assertNotEmpty($result);
        $this->assertTrue(file_exists($this->tmpDir . '/.env'));
        $this->assertStringContainsString('INSTALLATION_ID=' . $result, file_get_contents($this->tmpDir . '/.env'));
    }

    public function testDoesNotDuplicateKeyInExistingEnv(): void
    {
        $firstId = Installation::ensure($this->tmpDir);

        // Clear env so it reads from file
        unset($_ENV['INSTALLATION_ID'], $_SERVER['INSTALLATION_ID']);
        putenv('INSTALLATION_ID');

        $secondId = Installation::ensure($this->tmpDir);
        $this->assertSame($firstId, $secondId);
    }
}
