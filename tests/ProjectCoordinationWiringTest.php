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
        $this->assertStringContainsString("#^/admin/projects/([^/]+)$#", $source);
        $this->assertStringContainsString("#^/admin/projects/([^/]+)/changes$#", $source);
        $this->assertStringContainsString("#^/projects$#", $source);
        $this->assertStringContainsString("#^/projects/([^/]+)/bootstrap$#", $source);
        $this->assertStringContainsString("#^/projects/([^/]+)/notes$#", $source);
        $this->assertStringContainsString("#^/projects/([^/]+)/todos$#", $source);
        $this->assertStringContainsString("#^/projects/([^/]+)/files$#", $source);
        $this->assertStringContainsString("#^/projects/([^/]+)/feedback$#", $source);
        $this->assertStringNotContainsString("#^/project/bootstrap$#", $source);
        $this->assertStringNotContainsString("#^/bootstrap$#", $source);
        $this->assertStringNotContainsString("#^/b/([^/]+)$#", $source);
        $this->assertStringNotContainsString("#^/p/([^/]+)$#", $source);
        $this->assertStringNotContainsString("#^/project/changes$#", $source);
        $this->assertStringNotContainsString("#^/project/agents$#", $source);
        $this->assertStringNotContainsString("#^/project/notes$#", $source);
        $this->assertStringNotContainsString("#^/project/todo$#", $source);
        $this->assertStringNotContainsString("#^/project/files$#", $source);
        $this->assertStringNotContainsString("#^/help$#", $source);
    }

    public function testAdminHtmlIncludesProjectsSettingsTabAndAsset(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-settings-tab="projects"', $html);
        $this->assertStringContainsString('data-settings-panel="projects"', $html);
        $this->assertStringContainsString('id="projectsEnabledToggle"', $html);
        $this->assertStringContainsString('id="projectsTableBody"', $html);
        $this->assertStringContainsString('id="projectsListEmptyState"', $html);
        $this->assertStringContainsString('data-panel="project-detail"', $html);
        $this->assertStringContainsString('id="projectDetailPanel"', $html);
        $this->assertStringContainsString('id="projectDetailBack"', $html);
        $this->assertStringContainsString('id="projectDeleteModal"', $html);
        $this->assertStringContainsString('id="projectChangesList"', $html);
        $this->assertStringNotContainsString('id="projectCreateBtn"', $html);
        $this->assertStringContainsString('/admin/assets/projects.js?v=', $html);
    }

    public function testDashboardJsInitializesProjectsSettingsTabAndDetailRoute(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("if (settingsTab === 'projects' && window.__initProjects) window.__initProjects();", $js);
        $this->assertStringContainsString("if (panel === 'project-detail' && window.__loadProjectDetailByRoute) {", $js);
        $this->assertStringContainsString("document.body.dataset.projectSlug = decodeURIComponent(sub);", $js);
        $this->assertStringContainsString("show: ['projectDetailPanel']", $js);
        $this->assertStringContainsString("domains.add('projects');", $js);
    }

    public function testProjectsJsUsesDedicatedProjectDetailRouteAndDeleteModal(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/projects.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("history.pushState({}, '', '/admin/projects/' + encodeURIComponent(String(slug)));", $js);
        $this->assertStringContainsString("if (typeof window.__applyRouting === 'function') window.__applyRouting();", $js);
        $this->assertStringContainsString("projectDeleteModal?.classList.add('show');", $js);
        $this->assertStringContainsString("history.pushState({}, '', '/admin/settings/projects');", $js);
        $this->assertStringContainsString('await api(`/admin/projects/${encodeURIComponent(deletedSlug)}`, { method: \'DELETE\' });', $js);
    }

    public function testStartupSyncCarriesManagedSkillMetadata(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Services/StartupSyncService.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("'managed' => !empty(\$row['managed'])", $source);
    }
}
