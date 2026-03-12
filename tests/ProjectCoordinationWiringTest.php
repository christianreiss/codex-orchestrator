<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class ProjectCoordinationWiringTest extends TestCase
{
    public function testPublicRoutesExposeProjectCoordinationSurface(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("#^/admin/projects/state$#", $source);
        $this->assertStringContainsString("#^/admin/projects$#", $source);
        $this->assertStringContainsString("#^/admin/projects/([^/]+)/changes$#", $source);
        $this->assertStringContainsString("#^/projects$#", $source);
        $this->assertStringContainsString("#^/projects/([^/]+)/bootstrap$#", $source);
        $this->assertStringContainsString("#^/projects/([^/]+)/notes$#", $source);
        $this->assertStringContainsString("#^/projects/([^/]+)/todos$#", $source);
        $this->assertStringContainsString("#^/projects/([^/]+)/files$#", $source);
        $this->assertStringContainsString("#^/projects/([^/]+)/feedback$#", $source);
    }

    public function testAdminHtmlIncludesProjectsSettingsTabAndAsset(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-settings-tab="projects"', $html);
        $this->assertStringContainsString('data-settings-panel="projects"', $html);
        $this->assertStringContainsString('id="projectsEnabledToggle"', $html);
        $this->assertStringContainsString('id="projectsList"', $html);
        $this->assertStringContainsString('id="projectChangesList"', $html);
        $this->assertStringContainsString('/admin/assets/projects.js?v=', $html);
    }

    public function testDashboardJsInitializesProjectsSettingsTab(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("if (settingsTab === 'projects' && window.__initProjects) window.__initProjects();", $js);
        $this->assertStringContainsString("domains.add('projects');", $js);
    }

    public function testStartupSyncCarriesManagedSkillMetadata(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Services/StartupSyncService.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("'managed' => !empty(\$row['managed'])", $source);
    }
}
