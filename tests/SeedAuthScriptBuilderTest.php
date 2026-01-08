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
        $this->assertStringContainsString('curl -fsSL -X POST', $script);
        $this->assertStringContainsString('auth.json', $script);
    }
}
