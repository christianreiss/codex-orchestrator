<?php

namespace App\Http\Controllers;

use App\Exceptions\ValidationException;
use App\Http\CorsHelper;
use App\Http\RequestHelper;
use App\Http\Response;
use App\Mcp\McpServer;
use App\Mcp\McpToolNotFoundException;
use App\Repositories\McpAccessLogRepository;
use App\Services\AuthService;
use InvalidArgumentException;
use Throwable;

class McpRouteController
{
    public function __construct(
        private AuthService $service,
        private McpServer $mcpServer,
        private McpAccessLogRepository $mcpAccessLogRepository,
    ) {}

    /**
     * GET /mcp - spec requires GET handling; we only advertise POST.
     */
    public function probe(): void
    {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if (!CorsHelper::isOriginAllowed($origin)) {
            Response::json([
                'jsonrpc' => '2.0',
                'error' => ['code' => -32099, 'message' => 'Origin not allowed'],
                'id' => null,
            ], 403);
        }

        header('Allow: POST');
        Response::json([
            'status' => 'error',
            'message' => 'GET not supported for MCP stream; use POST JSON-RPC',
        ], 405);
    }

    /**
     * POST /mcp - JSON-RPC 2.0 MCP dispatch handler.
     */
    public function handle(?string $rawBody): void
    {
        $apiKey = RequestHelper::resolveApiKey();
        $clientIp = RequestHelper::resolveClientIp();

        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if (!CorsHelper::isOriginAllowed($origin)) {
            Response::json([
                'jsonrpc' => '2.0',
                'error' => ['code' => -32099, 'message' => 'Origin not allowed'],
                'id' => null,
            ], 403);
        }

        $host = $this->service->authenticateMcpCredential($apiKey, $clientIp);

        // Enforce insecure-host window the same way /auth does (extends window on access, denies when closed).
        $host = $this->service->enforceInsecureWindow($host, 'mcp');

        $decoded = json_decode($rawBody ?? '', true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            Response::json(['jsonrpc' => '2.0', 'error' => ['code' => -32700, 'message' => 'Parse error'], 'id' => null], 400);
        }

        $requests = [];
        $isBatch = false;
        if (is_array($decoded) && array_keys($decoded) === range(0, count($decoded) - 1)) {
            $isBatch = true;
            $requests = $decoded;
        } else {
            $requests = [$decoded];
        }

        $responses = [];

        foreach ($requests as $req) {
            if (!is_array($req) || ($req['jsonrpc'] ?? '') !== '2.0' || !isset($req['method'])) {
                $responses[] = [
                    'jsonrpc' => '2.0',
                    'error' => ['code' => -32600, 'message' => 'Invalid Request'],
                    'id' => $req['id'] ?? null,
                ];
                continue;
            }

            $method = (string) $req['method'];
            $id = $req['id'] ?? null;
            $params = is_array($req['params'] ?? null) ? $req['params'] : [];
            $isNotification = $id === null;

            $result = null;
            $error = null;
            $toolError = false;

            switch ($method) {
                case 'initialize':
                    $result = [
                        'protocolVersion' => '2025-03-26',
                        'capabilities' => [
                            'tools' => ['listChanged' => false],
                            'resources' => [
                                'subscribe' => false,
                                'listChanged' => false,
                            ],
                        ],
                        'serverInfo' => [
                            'name' => 'codex-orchestrator',
                            'version' => $this->service->versionSummary()['wrapper_version'] ?? 'unknown',
                        ],
                    ];
                    break;

                case 'tools/list':
                case 'tools.list':
                case 'list_tools':
                    $result = [
                        'tools' => $this->mcpServer->listTools(McpServer::CAPABILITY_HOST),
                    ];
                    break;

                case 'resources/templates/list':
                case 'resources.templates.list':
                case 'list_resource_templates':
                    $result = [
                        'resourceTemplates' => $this->mcpServer->listResourceTemplates(),
                    ];
                    break;

                case 'resources/list':
                case 'resources.list':
                case 'list_resources':
                    $result = [
                        'resources' => $this->mcpServer->listResources($host),
                    ];
                    break;

                case 'resources/read':
                case 'resources.read':
                case 'read_resource':
                    $uri = is_string($params['uri'] ?? null) ? (string) $params['uri'] : '';
                    if ($uri === '') {
                        $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => 'uri is required'];
                        break;
                    }
                    try {
                        $result = $this->mcpServer->readResource($uri, $host);
                    } catch (InvalidArgumentException $exception) {
                        $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => $exception->getMessage()];
                    }
                    break;

                case 'resources/create':
                case 'resources.create':
                case 'create_resource':
                    $uri = is_string($params['uri'] ?? null) ? (string) $params['uri'] : '';
                    if ($uri === '') {
                        $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => 'uri is required'];
                        break;
                    }
                    try {
                        $result = $this->mcpServer->createResource($uri, $params, $host);
                    } catch (InvalidArgumentException $exception) {
                        $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => $exception->getMessage()];
                    }
                    break;

                case 'resources/update':
                case 'resources.update':
                case 'update_resource':
                    $uri = is_string($params['uri'] ?? null) ? (string) $params['uri'] : '';
                    if ($uri === '') {
                        $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => 'uri is required'];
                        break;
                    }
                    try {
                        $result = $this->mcpServer->updateResource($uri, $params, $host);
                    } catch (InvalidArgumentException $exception) {
                        $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => $exception->getMessage()];
                    }
                    break;

                case 'resources/delete':
                case 'resources.delete':
                case 'delete_resource':
                    $uri = is_string($params['uri'] ?? null) ? (string) $params['uri'] : '';
                    if ($uri === '') {
                        $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => 'uri is required'];
                        break;
                    }
                    try {
                        $result = $this->mcpServer->deleteResource($uri, $host);
                    } catch (InvalidArgumentException $exception) {
                        $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => $exception->getMessage()];
                    }
                    break;

                case 'notifications/initialized':
                case 'notifications.initialized':
                    // Optional MCP notification; acknowledge and do nothing.
                    $result = ['ok' => true];
                    break;

                case 'tools/call':
                case 'tools.call':
                case 'call_tool':
                    $name = (string) ($params['name'] ?? '');
                    $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
                    if ($name === '') {
                        $result = $this->mcpServer->wrapContent('Tool name is required', true);
                        $toolError = true;
                        break;
                    }

                    try {
                        $result = $this->mcpServer->dispatch($name, $args, $host, McpServer::CAPABILITY_HOST);
                    } catch (McpToolNotFoundException $exception) {
                        $result = $this->mcpServer->wrapContent('Method not found: ' . $name, true);
                        $toolError = true;
                    } catch (InvalidArgumentException $exception) {
                        $result = $this->mcpServer->wrapContent($exception->getMessage(), true);
                        $toolError = true;
                    } catch (ValidationException $exception) {
                        $result = $this->mcpServer->wrapContent(json_encode($exception->getErrors(), JSON_UNESCAPED_SLASHES) ?: 'Invalid params', true);
                        $toolError = true;
                    } catch (Throwable $exception) {
                        $result = $this->mcpServer->wrapContent('Internal error: ' . $exception->getMessage(), true);
                        $toolError = true;
                    }
                    break;

                default:
                    $error = ['code' => -32601, 'message' => 'Method not found'];
            }

            // Log MCP access
            $this->mcpAccessLogRepository->log(
                $host['id'] ?? null,
                $clientIp,
                $method,
                isset($params['name']) ? (string) $params['name'] : (isset($params['uri']) ? (string) $params['uri'] : null),
                $error === null && !$toolError,
                $error['code'] ?? null,
                $error['message'] ?? null
            );

            if ($isNotification) {
                // No response for notifications.
                continue;
            }

            $response = ['jsonrpc' => '2.0', 'id' => $id];
            if ($error !== null) {
                $response['error'] = $error;
            } else {
                $response['result'] = $result;
            }
            $responses[] = $response;
        }

        if ($isBatch) {
            if (count($responses) === 0) {
                http_response_code(202);
                return;
            }
            header('Content-Type: application/json');
            echo json_encode($responses);
        } else {
            if (count($responses) === 0) {
                http_response_code(202);
                return;
            }
            header('Content-Type: application/json');
            echo json_encode($responses[0]);
        }
        exit;
    }
}
