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
use RuntimeException;

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

        $params = self::extractParams($payload);

        // Prefer top-level 'system' param (Anthropic native format) over inline system messages
        if (isset($payload['system']) && is_string($payload['system']) && trim($payload['system']) !== '') {
            $params['system'] = trim($payload['system']);
        } else {
            $extracted = AnthropicCompat::extractSystemMessages($messages);
            if ($extracted['system'] !== null && $extracted['system'] !== '') {
                $params['system'] = $extracted['system'];
                $messages = $extracted['messages'];
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

        $params = self::extractParams($payload);

        // Convert prompt to a single user message for the Messages API
        $messages = [['role' => 'user', 'content' => $prompt]];

        try {
            $result = $this->backend->messages($messages, $model, $params);
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

        if (!empty($payload['stream'])) {
            // Build a message-format result for the streaming helper
            $messageResult = [
                'id' => $result['id'] ?? ('msg_' . bin2hex(random_bytes(16))),
                'type' => 'message',
                'role' => 'assistant',
                'content' => [['type' => 'text', 'text' => $text]],
                'model' => $result['model'] ?? $model,
                'stop_reason' => 'end_turn',
                'stop_sequence' => null,
                'usage' => $result['usage'] ?? ['input_tokens' => 0, 'output_tokens' => 0],
            ];
            $this->streamResponse($messageResult);
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

        $params = self::extractParams($payload);

        if (!empty($payload['stream'])) {
            AnthropicResponse::error(
                'Streaming responses are not implemented for this backend yet.',
                'invalid_request_error',
                400,
                'unsupported_stream'
            );
        }

        try {
            $result = $this->backend->messages($messages, $model, $params);
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

    /**
     * Extract optional generation parameters from the request payload.
     *
     * Supports Claude-native parameters plus OpenAI-style 'stop' mapping
     * to 'stop_sequences' for cross-compatibility.
     *
     * @return array<string, mixed>
     */
    private static function extractParams(array $payload): array
    {
        $params = [];
        foreach (['max_tokens', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'system'] as $param) {
            if (isset($payload[$param])) {
                $params[$param] = $payload[$param];
            }
        }

        // Map OpenAI-style 'stop' to 'stop_sequences' for cross-compatibility
        if (isset($payload['stop']) && !isset($params['stop_sequences'])) {
            $params['stop_sequences'] = is_array($payload['stop']) ? $payload['stop'] : [$payload['stop']];
        }

        return $params;
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
                401,
                'invalid_api_key'
            );
        }

        $key = $this->keyService->validate($apiKey);
        if ($key === null) {
            AnthropicResponse::error('Invalid API key.', 'authentication_error', 401, 'invalid_api_key');
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
            AnthropicResponse::error(
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
            AnthropicResponse::error(
                'Anthropic API backend is not configured. Ensure the runner is available.',
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
            AnthropicResponse::error($e->getMessage(), 'invalid_request_error', 400);
        }
    }
}
