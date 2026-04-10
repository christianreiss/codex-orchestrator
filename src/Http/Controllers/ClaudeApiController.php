<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Adapters\ClaudeBackendAdapter;
use App\Http\AnthropicCompat;
use App\Http\AnthropicResponse;
use App\Repositories\VersionRepository;
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
        private readonly ClaudeModelService $modelService,
        private readonly ?VersionRepository $versionRepository = null
    ) {
    }

    public function messages(array $payload): void
    {
        $key = $this->authenticate();
        $this->enforceRateLimit($key);
        $this->ensureApiEnabled();
        $this->ensureBackend();

        $messages = AnthropicCompat::normalizeChatMessages($payload['messages'] ?? null);
        if ($messages === null) {
            AnthropicResponse::error('Missing required parameter: messages', 'invalid_request_error', 400);
        }

        $model = $this->resolveModel($payload['model'] ?? null);

        $params = [];
        foreach (['max_tokens', 'temperature', 'top_p', 'top_k', 'stop_sequences'] as $param) {
            if (isset($payload[$param])) {
                $params[$param] = $payload[$param];
            }
        }

        try {
            $result = $this->backend->messages($messages, $model, $params);
        } catch (\RuntimeException $e) {
            AnthropicResponse::error($e->getMessage(), 'api_error', 502);
        }

        if (!empty($payload['stream'])) {
            $this->streamResponse($result);
        }

        AnthropicResponse::json($result);
    }

    public function completions(array $payload): void
    {
        $key = $this->authenticate();
        $this->enforceRateLimit($key);
        $this->ensureApiEnabled();
        $this->ensureBackend();

        $prompt = $payload['prompt'] ?? null;
        if (!is_string($prompt) || trim($prompt) === '') {
            AnthropicResponse::error('Missing required parameter: prompt', 'invalid_request_error', 400);
        }

        $model = $this->resolveModel($payload['model'] ?? null);

        // Convert prompt to a single user message for the Messages API
        $messages = [['role' => 'user', 'content' => $prompt]];

        try {
            $result = $this->backend->messages($messages, $model);
        } catch (\RuntimeException $e) {
            AnthropicResponse::error($e->getMessage(), 'api_error', 502);
        }

        // Extract text from Anthropic response format
        $text = '';
        foreach ($result['content'] ?? [] as $block) {
            if (is_array($block) && ($block['type'] ?? '') === 'text') {
                $text .= $block['text'] ?? '';
            }
        }

        // Return in text_completion format for compatibility
        AnthropicResponse::json([
            'id' => $result['id'] ?? ('cmpl-' . bin2hex(random_bytes(12))),
            'type' => 'completion',
            'completion' => $text,
            'model' => $result['model'] ?? $model,
            'stop_reason' => $result['stop_reason'] ?? 'end_turn',
            'usage' => $result['usage'] ?? ['input_tokens' => 0, 'output_tokens' => 0],
        ]);
    }

    public function responses(array $payload): void
    {
        $key = $this->authenticate();
        $this->enforceRateLimit($key);
        $this->ensureApiEnabled();
        $this->ensureBackend();

        $messages = AnthropicCompat::normalizeResponsesInput(
            $payload['input'] ?? null,
            $payload['instructions'] ?? null
        );

        if ($messages === null) {
            AnthropicResponse::error('Missing required parameter: input', 'invalid_request_error', 400);
        }

        $model = $this->resolveModel($payload['model'] ?? null);

        if (!empty($payload['stream'])) {
            AnthropicResponse::error(
                'Streaming responses are not implemented for this backend yet.',
                'invalid_request_error',
                400,
                'unsupported_stream'
            );
        }

        try {
            $result = $this->backend->messages($messages, $model);
        } catch (\RuntimeException $e) {
            AnthropicResponse::error($e->getMessage(), 'api_error', 502);
        }

        AnthropicResponse::json(AnthropicCompat::responseFromMessage($result));
    }

    public function embeddings(array $payload): void
    {
        $this->authenticate();
        $this->ensureApiEnabled();
        $this->ensureBackend();

        $input = $payload['input'] ?? null;
        if ($input === null) {
            AnthropicResponse::error('Missing required parameter: input', 'invalid_request_error', 400);
        }

        $model = $this->resolveModel($payload['model'] ?? null);
        $result = $this->backend->embeddings($input, $model);

        if (isset($result['error'])) {
            AnthropicResponse::error(
                $result['error']['message'] ?? 'Embeddings not supported',
                $result['error']['type'] ?? 'not_implemented',
                501,
                $result['error']['code'] ?? null
            );
        }

        AnthropicResponse::json($result);
    }

    public function models(): void
    {
        $this->authenticate();
        $this->ensureApiEnabled();

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
        AnthropicResponse::streamEvents(AnthropicCompat::messageStreamEvents($result));
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

    private function ensureApiEnabled(): void
    {
        if ($this->versionRepository !== null && $this->versionRepository->getFlag('claude_api_disabled', false)) {
            AnthropicResponse::error('Claude API is currently disabled by administrator', 'api_error', 503);
        }
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
