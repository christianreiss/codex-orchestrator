<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Response;
use App\Services\OpenaiApiKeyService;

class AdminOpenAiKeyController
{
    public function __construct(
        private readonly OpenaiApiKeyService $keyService
    ) {
    }

    /**
     * GET /admin/openai/keys
     */
    public function index(): void
    {
        requireAdminAccess();

        Response::json([
            'status' => 'ok',
            'data' => $this->keyService->list(),
        ]);
    }

    /**
     * POST /admin/openai/keys
     */
    public function store(array $payload): void
    {
        requireAdminAccess();

        $name = trim((string) ($payload['name'] ?? ''));
        if ($name === '') {
            Response::json([
                'status' => 'error',
                'message' => 'name is required',
            ], 400);
        }

        $rateLimitRpm = (int) ($payload['rate_limit_rpm'] ?? 60);
        if ($rateLimitRpm <= 0) {
            $rateLimitRpm = 60;
        }

        $expiresAt = isset($payload['expires_at']) ? trim((string) $payload['expires_at']) : null;
        if ($expiresAt === '') {
            $expiresAt = null;
        }

        $adminUserId = $this->currentAdminUserId();
        $result = $this->keyService->generate($name, $adminUserId, $rateLimitRpm, $expiresAt);

        Response::json([
            'status' => 'ok',
            'data' => [
                'key' => $result['key'],
                'record' => $result['record'],
            ],
        ]);
    }

    /**
     * POST /admin/openai/keys/{id}/toggle
     */
    public function toggle(string $id, array $payload): void
    {
        requireAdminAccess();

        $active = !empty($payload['active']);
        $this->keyService->toggleActive((int) $id, $active);

        Response::json([
            'status' => 'ok',
            'message' => $active ? 'Key enabled' : 'Key disabled',
        ]);
    }

    /**
     * DELETE /admin/openai/keys/{id}
     */
    public function delete(string $id): void
    {
        requireAdminAccess();

        $this->keyService->delete((int) $id);

        Response::json([
            'status' => 'ok',
            'message' => 'Key deleted',
        ]);
    }

    private function currentAdminUserId(): ?int
    {
        $user = $GLOBALS['adminAuthUser'] ?? null;
        if (!is_array($user)) {
            return null;
        }

        return isset($user['id']) ? (int) $user['id'] : null;
    }
}
