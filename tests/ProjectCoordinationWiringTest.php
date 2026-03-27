<?php

declare(strict_types=1);

use App\Repositories\LogRepository;
use App\Repositories\SkillRepository;
use App\Services\ProjectModuleService;
use App\Services\SkillService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class ProjectCoordinationWiringSkillRepository extends SkillRepository
{
    public function __construct()
    {
    }

    public function all(bool $includeDeleted = false): array
    {
        return [];
    }

    public function findBySlug(string $slug): ?array
    {
        return null;
    }

    public function upsert(
        string $slug,
        string $sha256,
        ?string $displayName,
        ?string $description,
        string $manifest,
        ?int $sourceHostId
    ): array {
        return [];
    }

    public function delete(string $slug): bool
    {
        return false;
    }
}

final class ProjectCoordinationWiringLogRepository extends LogRepository
{
    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
    }
}

final class ProjectCoordinationWiringProjectModuleService extends ProjectModuleService
{
    public function __construct()
    {
    }

    public function isEnabled(): bool
    {
        return true;
    }

    public function managedSkill(): ?array
    {
        $manifest = "# Managed CoCo\n";

        return [
            'id' => null,
            'slug' => self::MANAGED_SKILL_SLUG,
            'uri' => self::MANAGED_SKILL_URI,
            'sha256' => hash('sha256', $manifest),
            'display_name' => 'CoCo Projects',
            'description' => 'Managed project coordination skill',
            'manifest' => $manifest,
            'updated_at' => '2026-03-27T12:00:00Z',
            'deleted_at' => null,
            'managed' => true,
        ];
    }
}

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

    public function testManagedSkillMetadataIsServedThroughSkillService(): void
    {
        $service = new SkillService(
            new ProjectCoordinationWiringSkillRepository(),
            new ProjectCoordinationWiringLogRepository(),
            new ProjectCoordinationWiringProjectModuleService()
        );

        $skills = $service->listSkills();
        $retrieved = $service->retrieve('coco', null, null);

        $this->assertCount(1, $skills);
        $this->assertSame('coco', $skills[0]['slug']);
        $this->assertSame('skill://coco', $skills[0]['uri']);
        $this->assertTrue($skills[0]['managed']);
        $this->assertSame('updated', $retrieved['status']);
        $this->assertSame('skill://coco', $retrieved['uri']);
        $this->assertTrue($retrieved['managed']);
        $this->assertStringContainsString('# Managed CoCo', $retrieved['manifest']);
    }
}
