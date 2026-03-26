<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminHostDetailPageRoutingTest extends TestCase
{
    public function testApiFrontControllerDispatchesDedicatedHostDetailPath(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php')
            . file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminPageController.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("#^/admin/hosts/(\\d+)\$#", $source);
        $this->assertStringContainsString("/admin/index.php", $source);
    }

    public function testAdminDashboardUsesDedicatedHostDetailPanelWithoutModal(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-panel="host-detail"', $html);
        $this->assertStringContainsString('id="hostDetailPanel"', $html);
        $this->assertStringContainsString('id="hostDetailLayout"', $html);
        $this->assertStringContainsString('id="hostDetailActions"', $html);
        $this->assertStringContainsString('id="hostDetailSummary"', $html);
        $this->assertStringContainsString('id="hostDetailGrid"', $html);
        $this->assertStringContainsString('id="hostDetailProblems"', $html);
        $this->assertStringNotContainsString('id="hostDetailModal"', $html);
    }

    public function testDashboardJsRoutesHostRowsToDedicatedPath(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('parseHostIdFromPath', $js);
        $this->assertStringContainsString('window.location.assign(`/admin/hosts/${Math.trunc(numericId)}`);', $js);
        $this->assertStringContainsString("return { panel: 'host-detail', sub: seg2 };", $js);
        $this->assertStringContainsString('renderActiveHostDetail()', $js);
        $this->assertStringContainsString('btn.onclick = async (ev) => {', $js);
        $this->assertStringContainsString("await showConfirmModal('Clear auth'", $js);
    }

    public function testDashboardJsIgnoresInlineControlsWhenOpeningHostDetail(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('function shouldIgnoreHostRowNavigation(target) {', $js);
        $this->assertStringContainsString("return !!target.closest('a, button, input, label, select, textarea, summary, [role=\"button\"], [role=\"link\"], [contenteditable=\"true\"], .insecure-inline-toggle');", $js);
        $this->assertStringContainsString("if (shouldIgnoreHostRowNavigation(ev.target)) return;", $js);
    }
}
