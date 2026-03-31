<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Http\Response;
use App\Repositories\McpAccessLogRepository;
use App\Services\AdminAuthService;
use App\Services\AgentsService;
use App\Services\ClientConfigService;
use App\Services\MemoryService;
use App\Services\SkillDraftService;
use App\Services\SkillService;

class AdminConfigController
{
    public function __construct(
        private ClientConfigService $clientConfigService,
        private AgentsService $agentsService,
        private MemoryService $memoryService,
        private SkillService $skillService,
        private SkillDraftService $skillDraftService,
        private McpAccessLogRepository $mcpAccessLogRepository,
    ) {}

    /**
     * GET /admin/config
     */
    public function config(): void
    {
        requireAdminAccess();
        $doc = $this->clientConfigService->adminFetch();

        Response::json([
            'status' => 'ok',
            'data' => $doc,
        ]);
    }

    /**
     * GET /admin/mcp/logs
     */
    public function mcpLogs(): void
    {
        requireAdminAccess();

        $limit = resolveIntQuery('limit') ?? 200;
        $logs = $this->mcpAccessLogRepository->recent($limit);

        Response::json([
            'status' => 'ok',
            'data' => [
                'logs' => $logs,
            ],
        ]);
    }

    /**
     * POST /admin/config/render
     */
    public function configRender(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $settings = is_array($payload['settings'] ?? null) ? $payload['settings'] : [];
        $baseUrl = resolveBaseUrl();
        // For preview, inject managed MCP with a placeholder API key so the rendered output matches what hosts receive.
        $rendered = $this->clientConfigService->renderForHost($settings, null, $baseUrl, '<host api key>');

        Response::json([
            'status' => 'ok',
            'data' => $rendered,
        ]);
    }

    /**
     * POST /admin/config/store
     */
    public function configStore(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        try {
            $result = $this->clientConfigService->store(is_array($payload) ? $payload : [], null);
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        }

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * GET /admin/agents
     */
    public function agents(): void
    {
        requireAdminAccess();
        $doc = $this->agentsService->adminFetch();

        Response::json([
            'status' => 'ok',
            'data' => $doc,
        ]);
    }

    /**
     * GET /admin/agents/versions/{id}
     */
    public function agentsVersion(int $versionId): void
    {
        requireAdminAccess();

        try {
            $result = $this->agentsService->adminFetchVersion($versionId);
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        }

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * POST /admin/agents/store
     */
    public function agentsStore(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $content = '';
        if (is_array($payload)) {
            $content = (string) ($payload['content'] ?? ($payload['body'] ?? ''));
        }
        $sha = is_array($payload) ? ($payload['sha256'] ?? null) : null;

        try {
            $result = $this->agentsService->store($content, $sha, null);
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        }

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * POST /admin/agents/serve
     */
    public function agentsServe(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $mode = is_array($payload) ? (string) ($payload['mode'] ?? '') : '';
        $versionId = null;
        if (is_array($payload) && isset($payload['version_id'])) {
            $versionId = is_numeric($payload['version_id']) ? (int) $payload['version_id'] : null;
        }

        try {
            $result = $this->agentsService->setServeMode($mode, $versionId);
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        }

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * POST /admin/agents/revert
     */
    public function agentsRevert(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $versionId = null;
        if (is_array($payload) && isset($payload['version_id'])) {
            $versionId = is_numeric($payload['version_id']) ? (int) $payload['version_id'] : null;
        }

        try {
            $result = $this->agentsService->revertVersion($versionId ?? 0);
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        }

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * DELETE /admin/agents/versions/{id}
     */
    public function agentsDeleteVersion(int $versionId): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        try {
            $result = $this->agentsService->deleteVersion($versionId);
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        }

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * GET /admin/mcp/memories
     */
    public function memories(): void
    {
        requireAdminAccess();

        $query = isset($_GET['q']) ? (string) $_GET['q'] : ((isset($_GET['query']) ? (string) $_GET['query'] : ''));
        $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 50;
        $hostId = isset($_GET['host_id']) ? $_GET['host_id'] : null;
        $tagsRaw = $_GET['tags'] ?? '';
        $tags = [];
        if (is_string($tagsRaw) && trim($tagsRaw) !== '') {
            $tags = array_filter(array_map('trim', preg_split('/[,\s]+/', $tagsRaw)));
        }

        try {
            $result = $this->memoryService->adminSearch([
                'query' => $query,
                'limit' => $limit,
                'host_id' => $hostId,
                'tags' => $tags,
            ]);
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        }

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * DELETE /admin/mcp/memories/{id}
     */
    public function memoriesDelete(int $id): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $result = $this->memoryService->adminDelete($id);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * GET /admin/skills
     */
    public function skills(): void
    {
        requireAdminAccess();

        $skills = $this->skillService->listSkills(null, true);

        Response::json([
            'status' => 'ok',
            'data' => ['skills' => $skills],
        ]);
    }

    /**
     * GET /admin/skills/{slug}
     */
    public function skillShow(string $slug): void
    {
        requireAdminAccess();
        $slug = urldecode($slug);
        try {
            $skill = $this->skillService->find($slug);
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        }

        if ($skill === null) {
            Response::json([
                'status' => 'error',
                'message' => 'Skill not found',
            ], 404);
        }

        Response::json([
            'status' => 'ok',
            'data' => $skill,
        ]);
    }

    /**
     * POST /admin/skills/store
     */
    public function skillStore(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        try {
            $result = $this->skillService->store(is_array($payload) ? $payload : [], null);
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        }

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * POST /admin/skills/generate
     */
    public function skillGenerate(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        try {
            $result = $this->skillDraftService->generate(is_array($payload) ? $payload : [], null);
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
     * POST /admin/skills/assist
     */
    public function skillAssist(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        try {
            $result = $this->skillDraftService->assist(is_array($payload) ? $payload : [], null);
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
     * DELETE /admin/skills/{slug}
     */
    public function skillDelete(string $slug): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $slug = urldecode($slug);
        try {
            $deleted = $this->skillService->delete($slug);
        } catch (ValidationException $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $exception->getErrors(),
            ], 422);
        }

        if (!$deleted) {
            Response::json([
                'status' => 'error',
                'message' => 'Skill not found',
            ], 404);
        }

        Response::json([
            'status' => 'ok',
            'data' => [
                'deleted' => $slug,
            ],
        ]);
    }
}
