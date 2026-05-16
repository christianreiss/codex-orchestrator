<?php

declare(strict_types=1);

use App\Services\Wrapper\V2\SeedAuthScriptBuilderV2;
use App\Support\Engine;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class WrapperV2SeedAuthScriptBuilderTest extends TestCase
{
    public function testCodexShellReadsAuthJson(): void
    {
        $body = SeedAuthScriptBuilderV2::build('https://orch.example.com', '11111111-2222-3333-4444-555555555555', Engine::CODEX);
        $this->assertStringStartsWith('#!/bin/sh', $body);
        $this->assertStringContainsString('$HOME/.codex/auth.json', $body);
        $this->assertStringContainsString('/seed/v2/auth/11111111-2222-3333-4444-555555555555', $body);
    }

    public function testClaudeShellReadsCredentialsJson(): void
    {
        $body = SeedAuthScriptBuilderV2::build('https://orch.example.com', '11111111-2222-3333-4444-555555555555', Engine::CLAUDE);
        $this->assertStringContainsString('$HOME/.claude/.credentials.json', $body);
        $this->assertStringContainsString('Claude credentials', $body);
    }

    public function testRefusesEmptyToken(): void
    {
        $this->expectException(InvalidArgumentException::class);
        SeedAuthScriptBuilderV2::build('https://orch.example.com', '', Engine::CODEX);
    }
}
