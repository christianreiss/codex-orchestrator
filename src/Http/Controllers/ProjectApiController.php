<?php

namespace App\Http\Controllers;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Http\RequestHelper;
use App\Http\Response;
use App\Services\AuthService;
use App\Services\MemoryService;
use App\Services\ProjectCoordinationService;

class ProjectApiController
{
    public function __construct(
        private AuthService $service,
        private ProjectCoordinationService $projectCoordinationService,
        private MemoryService $memoryService,
    ) {}

    // ---------------------------------------------------------------
    //  Projects
    // ---------------------------------------------------------------

    public function index(): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->listProjects($host));
    }

    public function create(mixed $payload): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->createProject(is_array($payload) ? $payload : [], $host));
    }

    public function bootstrap(string $slug): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->bootstrap(urldecode($slug), $host));
    }

    public function detail(string $slug): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->projectDetail(urldecode($slug), $host));
    }

    public function updateAbout(string $slug, mixed $payload): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->updateAbout(urldecode($slug), is_array($payload) ? $payload : [], $host));
    }

    public function updateRoster(string $slug, mixed $payload): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->updateRoster(urldecode($slug), is_array($payload) ? $payload : [], $host));
    }

    public function listChanges(string $slug): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(function () use ($slug, $host) {
            $since = RequestHelper::resolveIntQuery('since') ?? 0;
            return $this->projectCoordinationService->listChanges(urldecode($slug), max(0, $since), $host);
        });
    }

    public function listNotes(string $slug): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->listNotes(urldecode($slug), $host));
    }

    public function createNote(string $slug, mixed $payload): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->upsertNote(urldecode($slug), null, is_array($payload) ? $payload : [], $host));
    }

    public function updateNote(string $slug, string $id, mixed $payload): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->upsertNote(urldecode($slug), (int) $id, is_array($payload) ? $payload : [], $host));
    }

    public function deleteNote(string $slug, string $id): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->deleteNote(urldecode($slug), (int) $id, $host));
    }

    public function listTodos(string $slug): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->listTodos(urldecode($slug), $host));
    }

    public function createTodo(string $slug, mixed $payload): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->createTodo(urldecode($slug), is_array($payload) ? $payload : [], $host));
    }

    public function updateTodo(string $slug, string $id, mixed $payload): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->updateTodo(urldecode($slug), (int) $id, is_array($payload) ? $payload : [], $host));
    }

    public function setTodoDone(string $slug, string $id): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->setTodoDone(urldecode($slug), (int) $id, true, $host));
    }

    public function setTodoUndone(string $slug, string $id): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->setTodoDone(urldecode($slug), (int) $id, false, $host));
    }

    public function deleteTodo(string $slug, string $id): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->deleteTodo(urldecode($slug), (int) $id, $host));
    }

    public function listFiles(string $slug): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->listFiles(urldecode($slug), $host));
    }

    public function upsertFile(string $slug, mixed $payload): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->upsertFile(urldecode($slug), is_array($payload) ? $payload : [], $host));
    }

    public function deleteFile(string $slug, string $id): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->deleteFile(urldecode($slug), (int) $id, $host));
    }

    public function listFeedback(string $slug): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->listFeedback(urldecode($slug), $host));
    }

    public function createFeedback(string $slug, mixed $payload): void
    {
        $host = $this->authenticateHost();
        $this->respondProjectAction(fn () => $this->projectCoordinationService->createFeedback(urldecode($slug), is_array($payload) ? $payload : [], $host));
    }

    // ---------------------------------------------------------------
    //  MCP Memories (host-facing REST endpoints)
    // ---------------------------------------------------------------

    public function memoriesStore(mixed $payload): void
    {
        $host = $this->authenticateHost();
        $result = $this->memoryService->store(is_array($payload) ? $payload : [], $host);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    public function memoriesDelete(mixed $payload): void
    {
        $host = $this->authenticateHost();
        $result = $this->memoryService->delete(is_array($payload) ? $payload : [], $host);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    public function memoriesDeleteById(string $id): void
    {
        $host = $this->authenticateHost();
        $id = rawurldecode($id);
        $result = $this->memoryService->delete(['id' => $id], $host);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    public function memoriesRetrieve(mixed $payload): void
    {
        $host = $this->authenticateHost();
        $result = $this->memoryService->retrieve(is_array($payload) ? $payload : [], $host);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    public function memoriesSearch(mixed $payload): void
    {
        $host = $this->authenticateHost();
        $result = $this->memoryService->search(is_array($payload) ? $payload : [], $host);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    // ---------------------------------------------------------------
    //  Helpers
    // ---------------------------------------------------------------

    /** @return array<string, mixed> */
    private function authenticateHost(): array
    {
        $apiKey = RequestHelper::resolveApiKey();
        $clientIp = RequestHelper::resolveClientIp();

        return $this->service->authenticate($apiKey, $clientIp);
    }

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
}
