<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminChatGptUsageDualLaneTest extends TestCase
{
    public function testDashboardSupportsNormalAndSparkQuotaLanes(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("function renderUsageLaneCard(eyebrow, title, copy, rows = [], compare = '', active = false) {", $js);
        $this->assertStringContainsString("title: 'Normal'", $js);
        $this->assertStringContainsString("title: 'Spark'", $js);
        $this->assertStringContainsString("{ label: '5-hour runway', data: normalPrimary, windowKey: 'normal:primary' }", $js);
        $this->assertStringContainsString("{ label: 'Weekly runway', data: normalSecondary, windowKey: 'normal:secondary' }", $js);
        $this->assertStringContainsString("{ label: '5-hour runway', data: sparkPrimary, windowKey: 'spark:primary' }", $js);
        $this->assertStringContainsString("{ label: 'Weekly runway', data: sparkSecondary, windowKey: 'spark:secondary' }", $js);
        $this->assertStringContainsString('active_quota_lane', $js);
        $this->assertStringContainsString('spark_primary_used_percent', $js);
        $this->assertStringContainsString('spark:primary', $js);
        $this->assertStringContainsString("usage-cockpit-grid\${hasSpark ? '' : ' is-single'}", $js);
        $this->assertStringContainsString("querySelectorAll('.usage-lane')", $js);
        $this->assertStringNotContainsString('primary-card-label">Usage', $js);
        $this->assertStringNotContainsString('primary-card-head', $js);
        $this->assertStringNotContainsString('primary-card-footer', $js);
        $this->assertStringNotContainsString('Quota cockpit', $js);
        $this->assertStringNotContainsString('Two lanes. Two stacked bars each.', $js);
        $this->assertStringNotContainsString('Normal lane is pacing the run. Burst hard in the short window, but keep the weekly runway healthy.', $js);
        $this->assertStringNotContainsString('Spark is on point right now. Keep the sprint clean, then leave enough juice for the week.', $js);
        $this->assertStringNotContainsString('Active lane:', $js);
        $this->assertStringNotContainsString('Snapshot cached', $js);
        $this->assertStringNotContainsString('Next pull ${escapeHtml(next)}', $js);
        $this->assertStringNotContainsString('spark_limit_name', $js);
        $this->assertStringNotContainsString('usage-cockpit-meta', $js);

        $css = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.css');
        $this->assertIsString($css);
        $this->assertStringContainsString('#chatgpt-usage-card {', $css);
        $this->assertStringContainsString('background: transparent;', $css);
        $this->assertStringContainsString('.panel-set[data-panel="dashboard"] .usage-cockpit {', $css);
        $this->assertStringContainsString('padding: 18px 20px;', $css);
    }
}
