<?php

use PHPUnit\Framework\TestCase;

final class AdminHostAgentsVersionEndpointTest extends TestCase
{
    public function testEndpointIsRegisteredInRouter(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/hosts/(\\\\d+)/agents-version$#",
            $routerSource,
            'Expected /admin/hosts/{id}/agents-version route to exist in public/index.php'
        );
    }

    public function testHostListIncludesAgentsDocumentOverrideField(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString("'agents_document_id_override'", $routerSource);
    }
}
