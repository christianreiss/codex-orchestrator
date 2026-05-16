<?php

declare(strict_types=1);

use App\Services\Wrapper\V2\InstallerScriptBuilderV2;
use App\Support\Engine;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class WrapperV2InstallerScriptBuilderTest extends TestCase
{
    public function testInstallerContainsShimAndHints(): void
    {
        $host = ['id' => 42, 'fqdn' => 'host01.example.com'];
        $token = ['id' => 1, 'host_id' => 42, 'api_key' => 'sk-codex-abc'];
        $body = InstallerScriptBuilderV2::build($host, $token, 'https://orch.example.com', Engine::CODEX);
        $this->assertStringStartsWith('#!/bin/sh', $body);
        $this->assertStringContainsString('host01.example.com', $body);
        $this->assertStringContainsString('__CODEX_WRAPPER_SHIM__', $body);
        $this->assertStringContainsString('Installing the cdx wrapper', $body);
        $this->assertStringContainsString('Codex CLI manually', $body);
    }

    public function testClaudeVariantUsesClaudeHints(): void
    {
        $host = ['id' => 7, 'fqdn' => 'h.example.com'];
        $token = ['id' => 2, 'host_id' => 7, 'api_key' => 'sk-claude-abc'];
        $body = InstallerScriptBuilderV2::build($host, $token, 'https://orch.example.com', Engine::CLAUDE);
        $this->assertStringContainsString('Install Claude CLI manually', $body);
        $this->assertStringContainsString('Installing the clx wrapper', $body);
    }

    public function testRefusesMissingApiKey(): void
    {
        $host = ['id' => 1, 'fqdn' => 'h'];
        $this->expectException(InvalidArgumentException::class);
        InstallerScriptBuilderV2::build($host, ['api_key' => ''], 'https://orch.example.com', Engine::CODEX);
    }
}
