<?php

namespace App\Http\Controllers;

use App\Http\Response;
use App\Services\AgentsService;
use App\Services\AuthService;
use App\Services\ClientConfigService;

use function App\Http\resolveApiKey;
use function App\Http\resolveBaseUrl;
use function App\Http\resolveClientIp;

class ConfigApiController
{
    public function __construct(
        private AuthService $service,
        private AgentsService $agentsService,
        private ClientConfigService $clientConfigService,
    ) {}

    public function agentsRetrieve(mixed $payload): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $host = $this->service->authenticate($apiKey, $clientIp);

        $sha = is_array($payload) && array_key_exists('sha256', $payload) ? (string) $payload['sha256'] : null;
        $result = $this->agentsService->retrieve($sha, $host);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    public function configRetrieve(mixed $payload): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $host = $this->service->authenticate($apiKey, $clientIp);
        $baseUrl = resolveBaseUrl();

        $sha = is_array($payload) && array_key_exists('sha256', $payload) ? (string) $payload['sha256'] : null;
        $username = is_array($payload) && array_key_exists('username', $payload) ? (string) $payload['username'] : null;
        $home = is_array($payload) && array_key_exists('home', $payload) ? (string) $payload['home'] : null;
        $result = $this->clientConfigService->retrieve($sha, $host, $baseUrl, $apiKey, $username, $home);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }
}
