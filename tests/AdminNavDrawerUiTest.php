<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminNavDrawerUiTest extends TestCase
{
    public function testAdminMarkupIncludesDrawerNavigationShell(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-nav-version="2026"', $html);
        $this->assertStringContainsString('class="editorial-rail"', $html);
        $this->assertStringContainsString('id="navMenuToggle"', $html);
        $this->assertStringContainsString('id="navDrawer"', $html);
        $this->assertStringContainsString('id="navDrawerBackdrop"', $html);
        $this->assertStringContainsString('class="rail-frame"', $html);
        $this->assertStringContainsString('data-rail-trigger', $html);
        $this->assertStringContainsString('href="/admin/dashboard" data-nav="dashboard">Overview</a>', $html);
        $this->assertStringContainsString('id="navInsecureHosts" style="display:none;">Active Windows</button>', $html);
    }

    public function testNavControllerWiresDrawerAndActiveSyncBehavior(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/nav.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('editorial-rail-open', $js);
        $this->assertStringContainsString('navMenuToggle', $js);
        $this->assertStringContainsString('navDrawerBackdrop', $js);
        $this->assertStringContainsString("const groups = Array.from(rail.querySelectorAll('.rail-group'));", $js);
        $this->assertStringContainsString("const shouldOpenForFocus = (group, target) => {", $js);
        $this->assertStringContainsString("return trigger.matches(':focus-visible');", $js);
        $this->assertStringContainsString("body.style.setProperty('--nav-height'", $js);
        $this->assertStringContainsString('new ResizeObserver(() => {', $js);
        $this->assertStringContainsString("window.addEventListener('popstate', syncActiveLinks);", $js);
        $this->assertStringContainsString("attributeFilter: ['data-view-mode']", $js);
    }

    public function test2026NavStylesAreScopedAndResponsive(): void
    {
        $css = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.css');
        $this->assertIsString($css);

        $this->assertStringContainsString('body[data-nav-version="2026"] .editorial-rail', $css);
        $this->assertStringContainsString('body[data-nav-version="2026"] .rail-frame', $css);
        $this->assertStringContainsString('body[data-nav-version="2026"] .rail-panel', $css);
        $this->assertStringContainsString('body[data-nav-version="2026"] .rail-tools', $css);
        $this->assertStringContainsString('body[data-nav-version="2026"] .editorial-rail-backdrop', $css);
        $this->assertStringContainsString('@media (max-width: 940px)', $css);
    }
}
