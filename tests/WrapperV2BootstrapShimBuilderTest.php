<?php

declare(strict_types=1);

use App\Services\Wrapper\V2\BootstrapShimBuilder;
use App\Support\Engine;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class WrapperV2BootstrapShimBuilderTest extends TestCase
{
    public function testEmitsExecutableShellShim(): void
    {
        $shim = BootstrapShimBuilder::build(Engine::CODEX, 'https://orch.example.com', 'sk-codex-abc');
        $this->assertStringStartsWith('#!/bin/sh', $shim);
        $this->assertStringContainsString('HOST_API_KEY=', $shim);
        $this->assertStringContainsString('sk-codex-abc', $shim);
        $this->assertStringContainsString('/wrapper/v2/config?engine=codex', $shim);
        $this->assertStringContainsString('exec "$BIN_DIR/cdx" --config "$CFG"', $shim);
    }

    public function testQuotesPathologicalApiKey(): void
    {
        $shim = BootstrapShimBuilder::build(Engine::CLAUDE, 'https://orch.example.com', "sk-claude-' OR 1=1; rm -rf /");
        // The single-quote wrapping must keep the injection inert.
        $this->assertStringNotContainsString("rm -rf /' \n", $shim);
        // Ensure the apostrophe gets escaped via '\\''.
        $this->assertStringContainsString("'\\''", $shim);
        $this->assertStringContainsString('clx', $shim);
    }

    public function testClaudeShimSetsClaudeUrl(): void
    {
        $shim = BootstrapShimBuilder::build(Engine::CLAUDE, 'https://orch.example.com', 'sk-claude-abc');
        $this->assertStringContainsString('/wrapper/v2/config?engine=claude', $shim);
        $this->assertStringContainsString('exec "$BIN_DIR/clx"', $shim);
    }
}
