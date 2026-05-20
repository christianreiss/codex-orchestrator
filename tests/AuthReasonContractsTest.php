<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AuthReasonContractsTest extends TestCase
{
    public function testServerEmitsStableAuthDenyReasonCodes(): void
    {
        $serviceSource = @file_get_contents(__DIR__ . '/../src/Services/AuthService.php');
        self::assertIsString($serviceSource);

        self::assertStringContainsString("'code' => 'reverse_dns_mismatch'", $serviceSource);
        self::assertStringContainsString("'code' => 'insecure_api_disabled'", $serviceSource);
        self::assertStringContainsString("'expected_ip' => \$storedIp4", $serviceSource);
        self::assertStringContainsString("'received_ip' => \$normalizedIp", $serviceSource);
    }

    public function testWrapperMapsStableAuthDenyReasonCodes(): void
    {
        // The bash wrapper's Python auth-sync script mapped server-side deny
        // codes to stable exit codes and human messages. In the Go wrapper this
        // logic lives in orchestrator/auth_decide.go (Decide) and is consumed by
        // lifecycle/run.go which refuses launch with a typed AuthDecision.
        $decideSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/orchestrator/auth_decide.go');
        self::assertIsString($decideSource);

        // "disabled" → API kill-switch maps to a stable denial message.
        self::assertStringContainsString('Auth API disabled by administrator', $decideSource);

        // "insecure" → approval-pending poll (mirrors legacy insecure window check).
        self::assertStringContainsString('Insecure host approval pending', $decideSource);

        // "insecure-denied" → approval denied message.
        self::assertStringContainsString('Insecure host approval denied', $decideSource);

        // "invalid" → bad API key refusal.
        self::assertStringContainsString('Invalid API key', $decideSource);

        // "reverse_dns_mismatch" is a server-side code; the decision engine
        // treats any unrecognised status as a stable refusal rather than silently
        // allowing through.
        self::assertStringContainsString('Unknown auth status', $decideSource);
        self::assertStringContainsString('refusing to start Codex', $decideSource);

        // The installation_id mismatch check is preserved.
        self::assertStringContainsString('installation_id', $decideSource);
        self::assertStringContainsString('Installation ID mismatch', $decideSource);
    }
}
