<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminPasskeyOriginFallbackTest extends TestCase
{
    public function testAdminWebAuthnRpIdFallsBackToPublicBaseUrlHost(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("normalizeBaseUrlCandidate((string) Config::get('PUBLIC_BASE_URL', ''))", $source);
        $this->assertStringContainsString("parse_url(\$publicBase, PHP_URL_HOST)", $source);
    }

    public function testAdminWebAuthnOriginFallsBackToPublicBaseUrlOrigin(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("\$publicOrigin = normalizeOrigin(\$publicBase);", $source);
        $this->assertStringContainsString("return \$publicOrigin;", $source);
    }
}
