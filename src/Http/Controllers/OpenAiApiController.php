<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Contracts\BackendAdapter;
use App\Http\OpenAiCompat;
use App\Http\OpenAiResponse;
use App\Security\RateLimiter;
use App\Services\OpenAiModelService;
use App\Services\OpenaiApiKeyService;
use InvalidArgumentException;
use RuntimeException;

class OpenAiApiController
{
    public function __construct(
        private readonly ?BackendAdapter $backend,
        private readonly OpenaiApiKeyService $keyService,
        private readonly RateLimiter $rateLimiter,
        private readonly OpenAiModelService $modelService
    ) {
    }

    public function chatCompletions(array $payload): void
    {
        $key = $this->authenticate();
        $this->enforceRateLimit($key);
        $this->ensureBackend();

        $messages = $payload['messages'] ?? null;
        if (!is_array($messages) || $messages === []) {
            OpenAiResponse::error('Missing required parameter: messages', 'invalid_request_error', 400, null, 'messages');
        }

        $model = $this->resolveModel($payload['model'] ?? null);

        try {
            $result = $this->backend->chatCompletions($messages, $model);
        } catch (\RuntimeException $e) {
            OpenAiResponse::error($e->getMessage(), 'api_error', 502);
        }

        if (!empty($payload['stream'])) {
            OpenAiResponse::streamEvents(OpenAiCompat::chatCompletionStreamEvents($result));
        }

        OpenAiResponse::json($result);
    }

    public function responses(array $payload): void
    {
        $key = $this->authenticate();
        $this->enforceRateLimit($key);
        $this->ensureBackend();

        $messages = OpenAiCompat::normalizeResponsesInput(
            $payload['input'] ?? null,
            $payload['instructions'] ?? null
        );

        if ($messages === null) {
            OpenAiResponse::error('Missing required parameter: input', 'invalid_request_error', 400, null, 'input');
        }

        $model = $this->resolveModel($payload['model'] ?? null);

        try {
            $result = $this->backend->chatCompletions($messages, $model);
        } catch (\RuntimeException $e) {
            OpenAiResponse::error($e->getMessage(), 'api_error', 502);
        }

        if (!empty($payload['stream'])) {
            OpenAiResponse::error(
                'Streaming responses are not implemented for this backend yet.',
                'invalid_request_error',
                400,
                'unsupported_stream'
            );
        }

        OpenAiResponse::json(OpenAiCompat::responseFromChatCompletion($result));
    }

    public function completions(array $payload): void
    {
        $key = $this->authenticate();
        $this->enforceRateLimit($key);
        $this->ensureBackend();

        $prompt = $payload['prompt'] ?? null;
        if (!is_string($prompt) || trim($prompt) === '') {
            OpenAiResponse::error('Missing required parameter: prompt', 'invalid_request_error', 400, null, 'prompt');
        }

        $model = $this->resolveModel($payload['model'] ?? null);

        try {
            $result = $this->backend->completions($prompt, $model);
        } catch (\RuntimeException $e) {
            OpenAiResponse::error($e->getMessage(), 'api_error', 502);
        }

        if (!empty($payload['stream'])) {
            OpenAiResponse::stream($result);
        }

        OpenAiResponse::json($result);
    }

    public function embeddings(array $payload): void
    {
        $this->authenticate();
        $this->ensureBackend();

        $input = $payload['input'] ?? null;
        if ($input === null) {
            OpenAiResponse::error('Missing required parameter: input', 'invalid_request_error', 400, null, 'input');
        }

        $model = $this->resolveModel($payload['model'] ?? null);
        $result = $this->backend->embeddings($input, $model);

        if (isset($result['error'])) {
            OpenAiResponse::error(
                $result['error']['message'] ?? 'Embeddings not supported',
                $result['error']['type'] ?? 'not_implemented',
                501,
                $result['error']['code'] ?? null
            );
        }

        OpenAiResponse::json($result);
    }

    public function models(): void
    {
        $this->authenticate();
        $this->ensureBackend();

        $result = $this->backend->models();
        OpenAiResponse::json($result);
    }

    public function options(): void
    {
        OpenAiResponse::options();
    }

    private function authenticate(): array
    {
        $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        if (!preg_match('/^Bearer\s+(.+)/i', $authHeader, $matches)) {
            OpenAiResponse::error(
                'Incorrect API key provided',
                'authentication_error',
                401,
                'invalid_api_key'
            );
        }

        $token = trim($matches[1]);
        $key = $this->keyService->validate($token);
        if ($key === null) {
            OpenAiResponse::error(
                'Incorrect API key provided',
                'authentication_error',
                401,
                'invalid_api_key'
            );
        }

        return $key;
    }

    private function enforceRateLimit(array $keyRecord): void
    {
        $clientIp = $_SERVER['REMOTE_ADDR'] ?? null;
        $rpm = (int) ($keyRecord['rate_limit_rpm'] ?? 60);
        $bucket = 'openai:' . ($keyRecord['id'] ?? 'unknown');

        $result = $this->rateLimiter->hit($clientIp, $bucket, $rpm, 60);
        if (!$result['allowed']) {
            header('Retry-After: 60');
            OpenAiResponse::error(
                'Rate limit exceeded. Please retry after 60 seconds.',
                'rate_limit_error',
                429,
                'rate_limit_exceeded'
            );
        }
    }

    private function ensureBackend(): void
    {
        if ($this->backend === null) {
            OpenAiResponse::error(
                'OpenAI API backend is not configured. Ensure the runner is available.',
                'api_error',
                503,
                'backend_unavailable'
            );
        }
    }

    private function resolveModel(mixed $value): string
    {
        try {
            return $this->modelService->resolveRequestedModel($value);
        } catch (InvalidArgumentException|RuntimeException $e) {
            OpenAiResponse::error($e->getMessage(), 'invalid_request_error', 400, null, 'model');
        }
    }
}
