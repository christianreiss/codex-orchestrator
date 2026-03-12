<?php

declare(strict_types=1);

use App\Exceptions\HttpException;
use App\Repositories\LogRepository;
use App\Repositories\ProjectEventRepository;
use App\Repositories\ProjectFeedbackRepository;
use App\Repositories\ProjectFileRepository;
use App\Repositories\ProjectNoteRepository;
use App\Repositories\ProjectRepository;
use App\Repositories\ProjectTodoRepository;
use App\Services\ProjectCoordinationService;
use App\Services\ProjectModuleService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class ProjectCoordinationServiceDeleteTest extends TestCase
{
    public function testDeleteProjectHardDeletesAndReturnsSlug(): void
    {
        $projects = $this->createMock(ProjectRepository::class);
        $projects->method('findBySlug')->with('apollo')->willReturn([
            'id' => 42,
            'slug' => 'apollo',
        ]);
        $projects->method('delete')->with(42)->willReturn(true);

        $logs = $this->createMock(LogRepository::class);
        $logs->expects($this->once())
            ->method('log')
            ->with(null, 'project.delete', ['slug' => 'apollo']);

        $service = new ProjectCoordinationService(
            $projects,
            $this->createMock(ProjectNoteRepository::class),
            $this->createMock(ProjectTodoRepository::class),
            $this->createMock(ProjectFileRepository::class),
            $this->createMock(ProjectFeedbackRepository::class),
            $this->createMock(ProjectEventRepository::class),
            new EnabledProjectModuleServiceForDelete(),
            $logs
        );

        $result = $service->deleteProject('apollo');

        $this->assertSame(['deleted' => 'apollo'], $result);
    }

    public function testDeleteProjectThrowsNotFoundWhenRepositoryDoesNotDelete(): void
    {
        $projects = $this->createMock(ProjectRepository::class);
        $projects->method('findBySlug')->with('apollo')->willReturn([
            'id' => 42,
            'slug' => 'apollo',
        ]);
        $projects->method('delete')->with(42)->willReturn(false);

        $service = new ProjectCoordinationService(
            $projects,
            $this->createMock(ProjectNoteRepository::class),
            $this->createMock(ProjectTodoRepository::class),
            $this->createMock(ProjectFileRepository::class),
            $this->createMock(ProjectFeedbackRepository::class),
            $this->createMock(ProjectEventRepository::class),
            new EnabledProjectModuleServiceForDelete(),
            $this->createMock(LogRepository::class)
        );

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('Project not found');

        $service->deleteProject('apollo');
    }
}

final class EnabledProjectModuleServiceForDelete extends ProjectModuleService
{
    public function __construct()
    {
    }

    public function isEnabled(): bool
    {
        return true;
    }
}
