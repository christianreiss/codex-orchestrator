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

final class ProjectCoordinationServiceExceptionOrderTest extends TestCase
{
    public function testBootstrapMissingProjectThrowsHttpExceptionWith404(): void
    {
        $service = $this->serviceWithMissingProject();

        try {
            $service->bootstrap('apollo');
            $this->fail('Expected missing project to throw');
        } catch (HttpException $exception) {
            $this->assertSame('Project not found', $exception->getMessage());
            $this->assertSame(404, $exception->statusCode());
        }
    }

    public function testCreateTodoMissingProjectThrowsHttpExceptionWith404(): void
    {
        $service = $this->serviceWithMissingProject();

        try {
            $service->createTodo('apollo', ['title' => 'Next action']);
            $this->fail('Expected missing project to throw');
        } catch (HttpException $exception) {
            $this->assertSame('Project not found', $exception->getMessage());
            $this->assertSame(404, $exception->statusCode());
        }
    }

    public function testDisabledModuleThrowsHttpExceptionWith404(): void
    {
        $projects = $this->createMock(ProjectRepository::class);
        $service = new ProjectCoordinationService(
            $projects,
            $this->createMock(ProjectNoteRepository::class),
            $this->createMock(ProjectTodoRepository::class),
            $this->createMock(ProjectFileRepository::class),
            $this->createMock(ProjectFeedbackRepository::class),
            $this->createMock(ProjectEventRepository::class),
            new DisabledProjectModuleServiceForExceptionOrder(),
            $this->createMock(LogRepository::class)
        );

        try {
            $service->listProjects();
            $this->fail('Expected disabled module to throw');
        } catch (HttpException $exception) {
            $this->assertSame('Project coordination disabled', $exception->getMessage());
            $this->assertSame(404, $exception->statusCode());
        }
    }

    private function serviceWithMissingProject(): ProjectCoordinationService
    {
        $projects = $this->createMock(ProjectRepository::class);
        $projects->method('findBySlug')->with('apollo')->willReturn(null);

        return new ProjectCoordinationService(
            $projects,
            $this->createMock(ProjectNoteRepository::class),
            $this->createMock(ProjectTodoRepository::class),
            $this->createMock(ProjectFileRepository::class),
            $this->createMock(ProjectFeedbackRepository::class),
            $this->createMock(ProjectEventRepository::class),
            new EnabledProjectModuleServiceForExceptionOrder(),
            $this->createMock(LogRepository::class)
        );
    }
}

final class EnabledProjectModuleServiceForExceptionOrder extends ProjectModuleService
{
    public function __construct()
    {
    }

    public function isEnabled(): bool
    {
        return true;
    }
}

final class DisabledProjectModuleServiceForExceptionOrder extends ProjectModuleService
{
    public function __construct()
    {
    }

    public function isEnabled(): bool
    {
        return false;
    }
}
