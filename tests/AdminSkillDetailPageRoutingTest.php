<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminSkillDetailPageRoutingTest extends TestCase
{
    public function testApiFrontControllerDispatchesDedicatedSkillPaths(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php')
            . file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminPageController.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("#^/admin/skills/new$#", $source);
        $this->assertStringContainsString("#^/admin/skills/([^/]+)$#", $source);
        $this->assertStringContainsString('public function skill(): void', $source);
        $this->assertStringContainsString('/admin/index.php', $source);
    }
}
