<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Adapters\ClaudeBackendAdapter;
use App\Http\AnthropicResponse;
use App\Security\RateLimiter;
use App\Services\ClaudeModelService;
use App\Services\OpenaiApiKeyService;
use InvalidArgumentException;

class ClaudeApiController
{
    public function __construct(
        private readonly ?ClaudeBackendAdapter $backend,
        private readonly OpenaiApiKeyService $keyService,
        private readonly RateLimiter $rateLimiter,
        private readonly ClaudeModelService $modelService
    ) {
    }

    public function messages(array $payload): void
    {
        $key = $this->authenticate();
        $this->enforceRateLimit($key);
        $this->ensureBackend();

        $messages = $payload['messages'] ?? null;
        if (!is_array($messages) || $messages === []) {
            AnthropicResponse::error('Missing required parameter: messages', 'invalid_request_error', 400);
        }

        $model = $this->resolveModel($payload['model'] ?? null);

        try {
            $result = $this->backend->messages($messages, $model);
        } catch (\RuntimeException $e) {
            AnthropicResponse::error($e->getMessage(), 'api_error', 502);
        }

        if (!empty($payload['stream'])) {
            $this->streamResponse($result);
        }

        AnthropicResponse::json($result);
    }

    public function models(): void
    {
        $this->authenticate();

        $result = $this->backend !== null
            ? $this->backend->models()
            : $this->fallbackModels();

        AnthropicResponse::json($result);
    }

    public function options(): void
    {
        AnthropicResponse::options();
    }

    private function streamResponse(array $result): never
    {
        $messageId = $result['id'] ?? ('msg_' . bin2hex(random_bytes(16)));
        $model = $result['model'] ?? ClaudeModelService::DEFAULT_MODEL;
        $outputTokens = $result['usage']['output_tokens'] ?? 0;
        $text = '';

        $content = $result['content'] ?? [];
        if (is_array($content)) {
            foreach ($content as $block) {
                if (is_array($block) && ($block['type'] ?? '') === 'text') {
                    $text = $block['text'] ?? '';
                    break;
                }
            }
        }

        $events = [
            [
                'event' => 'message_start',
                'data' => [
                    'type' => 'message_start',
                    'message' => [
                        'id' => $messageId,
                        'type' => 'message',
                        'role' => 'assistant',
                        'content' => [],
                        'model' => $model,
                        'stop_reason' => null,
                        'stop_sequence' => null,
                        'usage' => [
                            'input_tokens' => $result['usage']['input_tokens'] ?? 0,
                            'output_tokens' => 0,
                        ],
                    ],
                ],
            ],
            [
                'event' => 'content_block_start',
                'data' => [
                    'type' => 'content_block_start',
                    'index' => 0,
                    'content_block' => [
                        'type' => 'text',
                        'text' => '',
                    ],
                ],
            ],
            [
                'event' => 'content_block_delta',
                'data' => [
                    'type' => 'content_block_delta',
                    'index' => 0,
                    'delta' => [
                        'type' => 'text_delta',
                        'text' => $text,
                    ],
                ],
            ],
            [
                'event' => 'content_block_stop',
                'data' => [
                    'type' => 'content_block_stop',
                    'index' => 0,
                ],
            ],
            [
                'event' => 'message_delta',
                'data' => [
                    'type' => 'message_delta',
                    'delta' => [
                        'stop_reason' => 'end_turn',
                        'stop_sequence' => null,
                    ],
                    'usage' => [
                        'output_tokens' => $outputTokens,
                    ],
                ],
            ],
            [
                'event' => 'message_stop',
                'data' => [
                    'type' => 'message_stop',
                ],
            ],
        ];

        AnthropicResponse::streamEvents($events);
    }

    private function fallbackModels(): array
    {
        $data = [];
        $createdAt = time();
        foreach ($this->modelService->supportedModels() as $model) {
            $data[] = [
                'id' => $model,
                'object' => 'model',
                'created' => $createdAt,
                'owned_by' => 'anthropic',
            ];
        }

        return [
            'data' => $data,
            'object' => 'list',
        ];
    }

    private function authenticate(): array
    {
        $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['HTTP_X_API_KEY'] ?? '';
        $apiKey = '';

        if (is_string($authHeader)) {
            if (str_starts_with($authHeader, 'Bearer ')) {
                $apiKey = substr($authHeader, 7);
            } elseif (str_starts_with($authHeader, 'x-api-key ')) {
                $apiKey = substr($authHeader, 10);
            } else {
                $apiKey = $authHeader;
            }
        }

        $apiKey = trim($apiKey);
        if ($apiKey === '') {
            AnthropicResponse::error(
                'Missing API key. Include it in the Authorization header or x-api-key header.',
                'authentication_error',
                401
            );
        }

        $key = $this->keyService->validate($apiKey);
        if ($key === null) {
            AnthropicResponse::error('Invalid API key.', 'authentication_error', 401);
        }

        return $key;
    }

    private function enforceRateLimit(array $key): void
    {
        $clientIp = $_SERVER['REMOTE_ADDR'] ?? null;
        $rpm = (int) ($key['rate_limit_rpm'] ?? 60);
        $bucket = 'anthropic:' . ($key['id'] ?? 'unknown');

        $result = $this->rateLimiter->hit($clientIp, $bucket, $rpm, 60);
        if (!$result['allowed']) {
            header('Retry-After: 60');
            AnthropicResponse::error('Rate limit exceeded. Please retry after 60 seconds.', 'rate_limit_error', 429);
        }
    }

    private function ensureBackend(): void
    {
        if ($this->backend === null) {
            AnthropicResponse::error(
                'Anthropic API backend is not configured. Ensure the runner is available.',
                'api_error',
                503
            );
        }
    }

    private function resolveModel(mixed $value): string
    {
        try {
            return $this->modelService->resolveRequestedModel($value);
        } catch (InvalidArgumentException $e) {
            AnthropicResponse::error($e->getMessage(), 'invalid_request_error', 400);
        }
    }
}
