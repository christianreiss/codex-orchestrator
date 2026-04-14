<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class StartupSyncServiceEngineTest extends TestCase
{
    public function testCollectTakesEngineParamAndPropagatesToAgentsAndConfig(): void
    {
        $service = file_get_contents(__DIR__ . '/../src/Services/StartupSyncService.php');
        self::assertIsString($service);

        self::assertStringContainsString('public function collect(array $payload, array $host, string $baseUrl, string $apiKey, bool $includeContent = false, string $engine = Engine::CODEX)', $service);
        self::assertStringContainsString('$this->agents->retrieve($sha, $host, $engine)', $service);
        self::assertStringContainsString('$this->configs->retrieve($sha, $host, $baseUrl, $apiKey, $username, $home, $engine)', $service);
    }

    public function testResponseShapeExposesEngineSpecificFilenameAndFormat(): void
    {
        $service = file_get_contents(__DIR__ . '/../src/Services/StartupSyncService.php');
        self::assertIsString($service);

        self::assertStringContainsString("'filename' => Engine::agentsDocument(\$engine)", $service);
        self::assertStringContainsString("'filename' => Engine::configFile(\$engine)", $service);
        self::assertStringContainsString("'format' => Engine::CONFIG_FORMAT[\$engine] ?? 'toml'", $service);
    }
}
