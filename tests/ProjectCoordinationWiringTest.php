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
        $this->assertStringContainsString("#^/admin/projects/([^/]+)/assist$#", $source);
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
        // SvelteKit: the projects tab is a dedicated route page, not a panel in
        // a static HTML file. Verify the key source files exist and expose the
        // required surface.

        // Projects list page
        $listPage = file_get_contents(__DIR__ . '/../frontend/src/routes/projects/+page.svelte');
        $this->assertIsString($listPage);
        // Module-enabled toggle
        $this->assertStringContainsString('projects-enabled', $listPage);
        $this->assertStringContainsString('updateProjectsState', $listPage);
        // Project cards
        $this->assertStringContainsString('ProjectCard', $listPage);

        // Project detail layout (replaces projectDetailPanel / projectDetailBack)
        $detailLayout = file_get_contents(
            __DIR__ . '/../frontend/src/routes/projects/[slug]/+layout.svelte'
        );
        $this->assertIsString($detailLayout);
        // Back button navigates to /projects
        $this->assertStringContainsString('/projects', $detailLayout);
        // Delete project is exposed
        $this->assertStringContainsString('Delete project', $detailLayout);
        $this->assertStringContainsString('deleteProject', $detailLayout);

        // Project detail about / assist page
        $detailPage = file_get_contents(
            __DIR__ . '/../frontend/src/routes/projects/[slug]/+page.svelte'
        );
        $this->assertIsString($detailPage);
        $this->assertStringContainsString('assistProject', $detailPage);

        // API module wires the state + detail + assist endpoints
        $api = file_get_contents(__DIR__ . '/../frontend/src/lib/api/projects.ts');
        $this->assertIsString($api);
        $this->assertStringContainsString('/admin/projects', $api);
        $this->assertStringContainsString('assist', $api);
        $this->assertStringContainsString('deleteProject', $api);
        $this->assertStringContainsString('encodeURIComponent', $api);
    }

    public function testDashboardJsInitializesProjectsSettingsTabAndDetailRoute(): void
    {
        // SvelteKit: project routing is file-based. Verify the projects route
        // files and the WS invalidation map cover the same surface as the old
        // dashboard.js routing initialisation.

        // Projects list route exists
        $this->assertFileExists(__DIR__ . '/../frontend/src/routes/projects/+page.svelte');
        // Project detail route exists
        $this->assertFileExists(__DIR__ . '/../frontend/src/routes/projects/[slug]/+page.svelte');

        // WS events wire project.* events to the projects query cache
        $events = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/events.ts');
        $this->assertIsString($events);
        $this->assertStringContainsString('project.changed', $events);
        $this->assertStringContainsString('project.updated', $events);
        $this->assertStringContainsString('"projects"', $events);

        // Projects API exposes state endpoint and per-project detail key
        $api = file_get_contents(__DIR__ . '/../frontend/src/lib/api/projects.ts');
        $this->assertIsString($api);
        // State endpoint is composed from the BASE constant + '/state'
        $this->assertStringContainsString('/admin/projects', $api);
        $this->assertStringContainsString('/state', $api);
        $this->assertStringContainsString('projectKeys', $api);
    }

    public function testProjectsJsUsesDedicatedProjectDetailRouteAndDeleteModal(): void
    {
        // SvelteKit: the old projects.js surface is split across the projects
        // route files and the API module.

        $detailLayout = file_get_contents(
            __DIR__ . '/../frontend/src/routes/projects/[slug]/+layout.svelte'
        );
        $this->assertIsString($detailLayout);

        // Navigation uses SvelteKit goto (replaces history.pushState)
        $this->assertStringContainsString('goto', $detailLayout);
        $this->assertStringContainsString('/projects', $detailLayout);
        // Delete uses a confirm dialog (replaces projectDeleteModal)
        $this->assertStringContainsString('confirmOpen', $detailLayout);
        $this->assertStringContainsString('ConfirmDialog', $detailLayout);
        $this->assertStringContainsString('deleteProject', $detailLayout);

        // API module: delete sends DELETE to /admin/projects/{slug}
        $api = file_get_contents(__DIR__ . '/../frontend/src/lib/api/projects.ts');
        $this->assertIsString($api);
        $this->assertStringContainsString('api.delete', $api);
        $this->assertStringContainsString('encodeURIComponent', $api);

        // Assist endpoint wired
        $this->assertStringContainsString('assistProject', $api);
        $this->assertStringContainsString('/assist', $api);

        // Project detail page has assist mutation
        $detailPage = file_get_contents(
            __DIR__ . '/../frontend/src/routes/projects/[slug]/+page.svelte'
        );
        $this->assertIsString($detailPage);
        $this->assertStringContainsString('assistMutation', $detailPage);
        $this->assertStringContainsString('assistProject', $detailPage);
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
