<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CronControllerWrapperUpdateTest extends TestCase
{
    public function testCronCheckComputesWrapperUpdatesForRequestedEngine(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Http/Controllers/CronController.php');
        self::assertIsString($source);

        self::assertStringContainsString('$engine = VersionHelper::extractEngine($payload);', $source);
        self::assertStringContainsString('$versions = $this->service->versionSummary($engine);', $source);
        self::assertStringContainsString('$versions = $this->service->applyClientVersionOverrideForHost($versions, $host, $engine);', $source);
        self::assertStringContainsString("'wrapper' => \$wrapperUpdate", $source);
        self::assertStringContainsString("'action' => \$needClientUpdate ? 'update' : 'no_update'", $source);
    }

    public function testCronReportUsesEngineWhenPersistingVersions(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Http/Controllers/CronController.php');
        self::assertIsString($source);

        self::assertMatchesRegularExpression(
            '/if \(\$engine === Engine::CLAUDE\).*?updateClaudeVersions\(.*?else.*?updateReportedVersions\(/s',
            $source
        );
    }
}
