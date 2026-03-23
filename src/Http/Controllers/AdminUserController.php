<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Response;
use App\Repositories\AdminUserRepository;
use App\Services\AdminAuthService;
use App\Services\AdminUserService;

class AdminUserController
{
    public function __construct(
        private AdminUserService $adminUserService,
        private AdminUserRepository $adminUserRepository,
        private array $payload,
        private string $publicDir,
    ) {}

    /** GET /admin/users */
    public function index(): void
    {
        if (isBrowserRequest()) { require $this->publicDir . '/admin/index.php'; return; }
        requireAdminAccess();
        $hasUsers = $this->adminUserRepository->countUsers() > 0;
        if ($hasUsers) {
            requireAdminCapability(AdminAuthService::CAP_USERS_MANAGE);
        }
        Response::json([
            'status' => 'ok',
            'data' => [
                'users' => $this->adminUserService->listUsers(),
            ],
        ]);
    }

    /** POST /admin/users */
    public function store(): void
    {
        requireAdminAccess();
        $hasUsers = $this->adminUserRepository->countUsers() > 0;
        if ($hasUsers) {
            requireAdminCapability(AdminAuthService::CAP_USERS_MANAGE);
        }
        $user = $this->adminUserService->createUser(is_array($this->payload) ? $this->payload : []);
        Response::json([
            'status' => 'ok',
            'data' => [
                'user' => $user,
            ],
        ]);
    }

    /** POST /admin/users/{id} */
    public function update(string $id): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_USERS_MANAGE);
        $id = (int) $id;
        $user = $this->adminUserService->updateUser($id, is_array($this->payload) ? $this->payload : []);
        Response::json([
            'status' => 'ok',
            'data' => [
                'user' => $user,
            ],
        ]);
    }

    /** DELETE /admin/users/{id} */
    public function delete(string $id): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_USERS_MANAGE);
        $id = (int) $id;
        $this->adminUserService->deleteUser($id);
        Response::json([
            'status' => 'ok',
        ]);
    }

    /** POST /admin/users/wipe */
    public function wipe(): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_USERS_MANAGE);
        $confirm = is_array($this->payload) ? ($this->payload['confirm'] ?? null) : null;
        if ($confirm !== 'WIPE') {
            Response::json([
                'status' => 'error',
                'message' => 'Confirmation required',
            ], 422);
        }
        $this->adminUserService->wipeAllUsers();
        Response::json([
            'status' => 'ok',
        ]);
    }
}
