<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\RequestHelper;
use App\Http\Response;
use App\Services\AuthService;
use App\Services\SkillService;

class SkillApiController
{
    public function __construct(
        private AuthService $service,
        private SkillService $skillService,
    ) {}

    public function listSkills(): void
    {
        $host = $this->authenticateHost();
        $skills = $this->skillService->listSkills($host, true);

        Response::json([
            'status' => 'ok',
            'data' => [
                'skills' => $skills,
            ],
        ]);
    }

    public function retrieveSkill(mixed $payload): void
    {
        $host = $this->authenticateHost();

        $slug = is_array($payload) ? (string) ($payload['slug'] ?? ($payload['filename'] ?? '')) : '';
        $sha = is_array($payload) && array_key_exists('sha256', $payload) ? (string) $payload['sha256'] : null;
        $result = $this->skillService->retrieve($slug, $sha, $host);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    public function storeSkill(mixed $payload): void
    {
        $host = $this->authenticateHost();
        $result = $this->skillService->store(is_array($payload) ? $payload : [], $host);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /** @return array<string, mixed> */
    private function authenticateHost(): array
    {
        $apiKey = RequestHelper::resolveApiKey();
        $clientIp = RequestHelper::resolveClientIp();

        return $this->service->authenticate($apiKey, $clientIp);
    }
}
