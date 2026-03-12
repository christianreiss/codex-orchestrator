<?php

declare(strict_types=1);

use App\Repositories\LogRepository;
use App\Repositories\ProjectEventRepository;
use App\Repositories\ProjectFeedbackRepository;
use App\Repositories\ProjectFileRepository;
use App\Repositories\ProjectNoteRepository;
use App\Repositories\ProjectRepository;
use App\Repositories\ProjectTodoRepository;
use App\Repositories\VersionRepository;
use App\Services\ProjectCoordinationService;
use App\Services\ProjectModuleService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class BootstrapVersionRepository extends VersionRepository
{
    public function __construct()
    {
    }

    public function get(string $name): ?string
    {
        return $name === ProjectModuleService::ENABLED_FLAG ? '1' : null;
    }

    public function getWithMetadata(string $name): ?array
    {
        if ($name !== ProjectModuleService::ENABLED_FLAG) {
            return null;
        }

        return [
            'version' => '1',
            'updated_at' => '2026-03-12T12:00:00Z',
        ];
    }
}

final class ProjectCoordinationBootstrapTest extends TestCase
{
    public function testBootstrapIncludesManagedSkillMetadataAndNativeInstructions(): void
    {
        $project = [
            'id' => 42,
            'slug' => 'apollo',
            'about' => ['title' => 'Apollo'],
            'roster_markdown' => "# Apollo\n- coord",
            'latest_event_seq' => 7,
            'created_at' => '2026-03-12T11:00:00Z',
            'updated_at' => '2026-03-12T11:30:00Z',
        ];

        $projects = $this->createMock(ProjectRepository::class);
        $projects->method('findBySlug')->with('apollo')->willReturn($project);

        $notes = $this->createMock(ProjectNoteRepository::class);
        $notes->method('allByProjectId')->with(42)->willReturn([
            ['id' => 1, 'header' => 'Kickoff', 'body' => 'Imported backlog'],
        ]);

        $todos = $this->createMock(ProjectTodoRepository::class);
        $todos->method('allByProjectId')->with(42)->willReturn([
            ['id' => 1, 'title' => 'Next action', 'detail' => 'Do the thing', 'done' => 0],
            ['id' => 2, 'title' => 'Done item', 'detail' => 'Already finished', 'done' => 1],
        ]);

        $files = $this->createMock(ProjectFileRepository::class);
        $files->method('allByProjectId')->with(42)->willReturn([
            ['id' => 1, 'stored_name' => 'notes/rollout.md', 'content' => '# Rollout', 'updated_at' => '2026-03-12T11:20:00Z'],
        ]);

        $feedback = $this->createMock(ProjectFeedbackRepository::class);
        $feedback->method('all')->with(42)->willReturn([]);

        $events = $this->createMock(ProjectEventRepository::class);
        $events->method('recent')->with(42, 20)->willReturn([
            ['seq' => 7, 'kind' => 'note', 'action' => 'update'],
        ]);

        $service = new ProjectCoordinationService(
            $projects,
            $notes,
            $todos,
            $files,
            $feedback,
            $events,
            new ProjectModuleService(new BootstrapVersionRepository()),
            $this->createMock(LogRepository::class)
        );

        $bootstrap = $service->bootstrap('apollo');

        $this->assertSame('apollo', $bootstrap['project']);
        $this->assertSame('coco', $bootstrap['skill']['slug']);
        $this->assertSame('~/.agents/skills/coco/SKILL.md', $bootstrap['skill']['path']);
        $this->assertStringContainsString('~/.agents/skills/coco/SKILL.md', $bootstrap['instructions'][0]);
        $this->assertContains('project_bootstrap {"slug":"apollo"}', $bootstrap['quickstart']);
        $this->assertSame('/projects/apollo/bootstrap', $bootstrap['routes']['bootstrap']);
        $this->assertSame('/projects/apollo/changes', $bootstrap['routes']['changes']);
        $this->assertArrayNotHasKey('help', $bootstrap);
        $this->assertArrayNotHasKey('help', $bootstrap['routes']);
    }
}
