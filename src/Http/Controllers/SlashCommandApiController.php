<?php

namespace App\Http\Controllers;

use App\Http\RequestHelper;
use App\Http\Response;
use App\Services\AuthService;
use App\Services\SkillService;
use App\Services\SlashCommandService;

class SlashCommandApiController
{
    public function __construct(
        private AuthService $service,
        private SlashCommandService $slashCommandService,
        private SkillService $skillService,
    ) {}

    // ---------------------------------------------------------------
    //  Slash Commands
    // ---------------------------------------------------------------

    public function listCommands(): void
    {
        $host = $this->authenticateHost();
        $commands = $this->slashCommandService->listCommands($host, true);

        Response::json([
            'status' => 'ok',
            'data' => [
                'commands' => $commands,
            ],
        ]);
    }

    public function retrieveCommand(mixed $payload): void
    {
        $host = $this->authenticateHost();

        $filename = is_array($payload) ? (string) ($payload['filename'] ?? '') : '';
        $sha = is_array($payload) && array_key_exists('sha256', $payload) ? (string) $payload['sha256'] : null;
        $result = $this->slashCommandService->retrieve($filename, $sha, $host);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    public function storeCommand(mixed $payload): void
    {
        $host = $this->authenticateHost();
        $result = $this->slashCommandService->store(is_array($payload) ? $payload : [], $host);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    // ---------------------------------------------------------------
    //  Skills
    // ---------------------------------------------------------------

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
}
