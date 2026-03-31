<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Http\Response;
use App\Services\AdminAuthService;
use App\Services\ProjectCoordinationService;
use App\Services\ProjectDraftService;

class AdminProjectController
{
    public function __construct(
        private ProjectCoordinationService $projectCoordinationService,
        private ProjectDraftService $projectDraftService,
    ) {}

    /**
     * Wrap a project action callback with standard error handling.
     */
    private function respondProjectAction(callable $callback): void
    {
        try {
            $result = $callback();
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        } catch (HttpException $exception) {
            Response::json([
                'status' => 'error',
                'message' => $exception->getMessage(),
            ], $exception->getStatusCode());
        }

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * GET /admin/projects/state
     */
    public function state(): void
    {
        requireAdminAccess();
        $this->respondProjectAction(function () {
            return $this->projectCoordinationService->adminState();
        });
    }

    /**
     * POST /admin/projects/state
     */
    public function stateUpdate(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($payload) {
            $enabled = normalizeBoolean(is_array($payload) ? ($payload['enabled'] ?? null) : null);
            if ($enabled === null) {
                throw new ValidationException(['enabled' => ['enabled must be true or false']]);
            }

            return $this->projectCoordinationService->setEnabled($enabled);
        });
    }

    /**
     * GET /admin/projects/feedback
     */
    public function allFeedback(): void
    {
        requireAdminAccess();
        $this->respondProjectAction(function () {
            return $this->projectCoordinationService->listFeedback(null, null);
        });
    }

    /**
     * GET /admin/projects
     */
    public function index(): void
    {
        requireAdminAccess();
        $this->respondProjectAction(function () {
            return $this->projectCoordinationService->listProjects(null);
        });
    }

    /**
     * POST /admin/projects
     */
    public function create(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($payload) {
            return $this->projectCoordinationService->createProject(is_array($payload) ? $payload : [], null);
        });
    }

    /**
     * DELETE /admin/projects/{slug}
     */
    public function delete(string $slug): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug) {
            return $this->projectCoordinationService->deleteProject(urldecode($slug), null);
        });
    }

    /**
     * GET /admin/projects/{slug}
     */
    public function show(string $slug): void
    {
        requireAdminAccess();
        $this->respondProjectAction(function () use ($slug) {
            return $this->projectCoordinationService->projectDetail(urldecode($slug), null);
        });
    }

    /**
     * POST /admin/projects/{slug}/assist
     */
    public function assist(string $slug): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug) {
            return $this->projectDraftService->assist(urldecode($slug), null);
        });
    }

    /**
     * POST /admin/projects/{slug}/about
     */
    public function updateAbout(string $slug, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $payload) {
            return $this->projectCoordinationService->updateAbout(urldecode($slug), is_array($payload) ? $payload : [], null);
        });
    }

    /**
     * POST /admin/projects/{slug}/roster
     */
    public function updateRoster(string $slug, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $payload) {
            return $this->projectCoordinationService->updateRoster(urldecode($slug), is_array($payload) ? $payload : [], null);
        });
    }

    /**
     * GET /admin/projects/{slug}/changes
     */
    public function changes(string $slug): void
    {
        requireAdminAccess();
        $this->respondProjectAction(function () use ($slug) {
            $since = resolveIntQuery('since') ?? 0;
            return $this->projectCoordinationService->listChanges(urldecode($slug), max(0, $since), null);
        });
    }

    /**
     * GET /admin/projects/{slug}/notes
     */
    public function notes(string $slug): void
    {
        requireAdminAccess();
        $this->respondProjectAction(function () use ($slug) {
            return $this->projectCoordinationService->listNotes(urldecode($slug), null);
        });
    }

    /**
     * POST /admin/projects/{slug}/notes
     */
    public function noteCreate(string $slug, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $payload) {
            return $this->projectCoordinationService->upsertNote(urldecode($slug), null, is_array($payload) ? $payload : [], null);
        });
    }

    /**
     * POST /admin/projects/{slug}/notes/{id}
     */
    public function noteUpdate(string $slug, int $id, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $id, $payload) {
            return $this->projectCoordinationService->upsertNote(urldecode($slug), $id, is_array($payload) ? $payload : [], null);
        });
    }

    /**
     * DELETE /admin/projects/{slug}/notes/{id}
     */
    public function noteDelete(string $slug, int $id): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $id) {
            return $this->projectCoordinationService->deleteNote(urldecode($slug), $id, null);
        });
    }

    /**
     * GET /admin/projects/{slug}/todos
     */
    public function todos(string $slug): void
    {
        requireAdminAccess();
        $this->respondProjectAction(function () use ($slug) {
            return $this->projectCoordinationService->listTodos(urldecode($slug), null);
        });
    }

    /**
     * POST /admin/projects/{slug}/todos
     */
    public function todoCreate(string $slug, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $payload) {
            return $this->projectCoordinationService->createTodo(urldecode($slug), is_array($payload) ? $payload : [], null);
        });
    }

    /**
     * POST /admin/projects/{slug}/todos/{id}
     */
    public function todoUpdate(string $slug, int $id, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $id, $payload) {
            return $this->projectCoordinationService->updateTodo(urldecode($slug), $id, is_array($payload) ? $payload : [], null);
        });
    }

    /**
     * POST /admin/projects/{slug}/todos/{id}/done
     */
    public function todoDone(string $slug, int $id): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $id) {
            return $this->projectCoordinationService->setTodoDone(urldecode($slug), $id, true, null);
        });
    }

    /**
     * POST /admin/projects/{slug}/todos/{id}/undone
     */
    public function todoUndone(string $slug, int $id): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $id) {
            return $this->projectCoordinationService->setTodoDone(urldecode($slug), $id, false, null);
        });
    }

    /**
     * DELETE /admin/projects/{slug}/todos/{id}
     */
    public function todoDelete(string $slug, int $id): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $id) {
            return $this->projectCoordinationService->deleteTodo(urldecode($slug), $id, null);
        });
    }

    /**
     * GET /admin/projects/{slug}/files
     */
    public function files(string $slug): void
    {
        requireAdminAccess();
        $this->respondProjectAction(function () use ($slug) {
            return $this->projectCoordinationService->listFiles(urldecode($slug), null);
        });
    }

    /**
     * POST /admin/projects/{slug}/files
     */
    public function fileCreate(string $slug, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $payload) {
            return $this->projectCoordinationService->upsertFile(urldecode($slug), is_array($payload) ? $payload : [], null);
        });
    }

    /**
     * DELETE /admin/projects/{slug}/files/{id}
     */
    public function fileDelete(string $slug, int $id): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $id) {
            return $this->projectCoordinationService->deleteFile(urldecode($slug), $id, null);
        });
    }

    /**
     * GET /admin/projects/{slug}/feedback
     */
    public function feedback(string $slug): void
    {
        requireAdminAccess();
        $this->respondProjectAction(function () use ($slug) {
            return $this->projectCoordinationService->listFeedback(urldecode($slug), null);
        });
    }

    /**
     * POST /admin/projects/{slug}/feedback
     */
    public function feedbackCreate(string $slug, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $this->respondProjectAction(function () use ($slug, $payload) {
            return $this->projectCoordinationService->createFeedback(urldecode($slug), is_array($payload) ? $payload : [], null);
        });
    }
}
