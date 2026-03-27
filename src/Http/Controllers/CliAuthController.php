<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\RequestHelper;
use App\Http\Response;
use App\Services\AdminAuthService;
use App\Services\CliAuthService;

class CliAuthController
{
    public function __construct(
        private readonly CliAuthService $cliAuthService,
        private readonly AdminAuthService $adminAuthService,
        private readonly string $publicDir
    ) {
    }

    /** POST /cli/auth/start — CLI initiates a device-code login flow. */
    public function start(array $payload): void
    {
        $fqdn = trim((string) ($payload['fqdn'] ?? ''));
        $secure = (bool) ($payload['secure'] ?? true);
        $ip = RequestHelper::resolveClientIp();
        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? null;

        try {
            $data = $this->cliAuthService->startRequest($fqdn, $secure, $ip, $userAgent);
        } catch (\App\Exceptions\HttpException $e) {
            Response::json(['status' => 'error', 'message' => $e->getMessage()], $e->getStatusCode());
            return;
        }

        $baseUrl = rtrim(RequestHelper::resolveBaseUrl(), '/');
        $data['verify_url'] = $baseUrl . '/cli/auth/verify';

        Response::json(['status' => 'ok', 'data' => $data]);
    }

    /** POST /cli/auth/poll/{request_id} — CLI polls for approval status. */
    public function poll(string $requestId): void
    {
        $data = $this->cliAuthService->pollRequest($requestId);

        if ($data['status'] === 'not_found') {
            Response::json(['status' => 'error', 'message' => 'Request not found'], 404);
            return;
        }

        if ($data['status'] === 'approved') {
            $baseUrl = rtrim(RequestHelper::resolveBaseUrl(), '/');
            $data['base_url'] = $baseUrl;
        }

        Response::json(['status' => 'ok', 'data' => $data]);
    }

    /** GET /cli/auth/verify — serves the browser approval page. */
    public function verifyPage(): void
    {
        $session = \App\Http\AdminSessionHelper::resolveAdminSession($this->adminAuthService);
        $loginEnforced = $this->adminAuthService->isEnforced();

        if ($loginEnforced && ($session === null || !isset($session['user']))) {
            header('Location: /admin/login?return=/cli/auth/verify', true, 302);
            exit;
        }

        $html = $this->publicDir . '/cli-auth-verify.html';
        if (!is_file($html)) {
            Response::json(['status' => 'error', 'message' => 'Verification page not found'], 500);
            return;
        }

        header('Content-Type: text/html; charset=utf-8');
        readfile($html);
        exit;
    }

    /** POST /cli/auth/lookup — browser looks up a pending request by user code. */
    public function lookup(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);

        $userCode = trim((string) ($payload['user_code'] ?? ''));
        if ($userCode === '') {
            Response::json(['status' => 'error', 'message' => 'user_code is required'], 422);
            return;
        }

        $data = $this->cliAuthService->lookupRequest($userCode);
        if ($data === null) {
            Response::json(['status' => 'error', 'message' => 'Login request not found or expired'], 404);
            return;
        }

        Response::json(['status' => 'ok', 'data' => $data]);
    }

    /** POST /cli/auth/approve — browser approves a pending login request. */
    public function approve(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);

        $userCode = trim((string) ($payload['user_code'] ?? ''));
        if ($userCode === '') {
            Response::json(['status' => 'error', 'message' => 'user_code is required'], 422);
            return;
        }

        $adminUser = $GLOBALS['adminAuthUser'] ?? [];

        try {
            $data = $this->cliAuthService->approveRequest($userCode, $adminUser);
        } catch (\App\Exceptions\HttpException $e) {
            Response::json(['status' => 'error', 'message' => $e->getMessage()], $e->getStatusCode());
            return;
        }

        Response::json(['status' => 'ok', 'data' => $data]);
    }

    /** POST /cli/auth/deny — browser denies a pending login request. */
    public function deny(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);

        $userCode = trim((string) ($payload['user_code'] ?? ''));
        if ($userCode === '') {
            Response::json(['status' => 'error', 'message' => 'user_code is required'], 422);
            return;
        }

        try {
            $this->cliAuthService->denyRequest($userCode);
        } catch (\App\Exceptions\HttpException $e) {
            Response::json(['status' => 'error', 'message' => $e->getMessage()], $e->getStatusCode());
            return;
        }

        Response::json(['status' => 'ok', 'message' => 'Login request denied']);
    }
}
