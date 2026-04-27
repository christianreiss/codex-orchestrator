<?php

declare(strict_types=1);

use App\Support\CodexVersionPolicy;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class CodexVersionPolicyTest extends TestCase
{
    public function testNormalizeStripsCommonPrefixes(): void
    {
        $this->assertSame('0.114.0', CodexVersionPolicy::normalize('rust-v0.114.0'));
        $this->assertSame('0.120.1', CodexVersionPolicy::normalize('codex-cli v0.120.1'));
        $this->assertSame('0.121.0', CodexVersionPolicy::normalize('codex v0.121.0'));
    }

    public function testResolveEffectiveUsesMinimumFloorForMissingOrLowValues(): void
    {
        $this->assertSame(
            ['version' => '0.125.0', 'enforce_exact' => false],
            CodexVersionPolicy::resolveEffective(null, false)
        );
        $this->assertSame(
            ['version' => '0.125.0', 'enforce_exact' => false],
            CodexVersionPolicy::resolveEffective('0.101.0', true)
        );
        $this->assertSame(
            ['version' => '0.125.0', 'enforce_exact' => false],
            CodexVersionPolicy::resolveEffective('0.120.0', true)
        );
    }

    public function testResolveEffectiveKeepsHigherExplicitPinsExact(): void
    {
        $this->assertSame(
            ['version' => '0.126.0', 'enforce_exact' => true],
            CodexVersionPolicy::resolveEffective('rust-v0.126.0', true)
        );
        $this->assertSame(
            ['version' => '0.126.0', 'enforce_exact' => false],
            CodexVersionPolicy::resolveEffective('0.126.0', false)
        );
    }
}
