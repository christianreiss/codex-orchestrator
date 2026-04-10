<?php

declare(strict_types=1);

namespace App\Adapters;

use App\Contracts\BackendAdapter;
use App\Services\AuthService;
use App\Services\OpenAiModelService;
use App\Support\Engine;
use Throwable;

class RunnerBackendAdapter implements BackendAdapter
{
    public function __construct(
        private readonly string $runnerExecUrl,
        private readonly string $sharedSecret,
        private readonly AuthService $authService,
        private readonly OpenAiModelService $modelService,
        private readonly float $timeout = 30.0
    ) {
    }

    public function chatCompletions(array $messages, string $model, array $params = []): array
    {
        [$prompt, $images] = $this->buildPromptPayload($messages);

        $result = $this->runPrompt($prompt, $model, $images, $params);
        $usage = self::extractUsage($result);

        return [
            'id' => 'chatcmpl-' . bin2hex(random_bytes(12)),
            'object' => 'chat.completion',
            'created' => time(),
            'model' => $model,
            'choices' => [
                [
                    'index' => 0,
                    'message' => [
                        'role' => 'assistant',
                        'content' => $result['output'] ?? '',
                    ],
                    'finish_reason' => 'stop',
                ],
            ],
            'usage' => [
                'prompt_tokens' => $usage['prompt_tokens'],
                'completion_tokens' => $usage['completion_tokens'],
                'total_tokens' => $usage['total_tokens'],
            ],
        ];
    }

    public function completions(string $prompt, string $model, array $params = []): array
    {
        $result = $this->runPrompt($prompt, $model, [], $params);
        $usage = self::extractUsage($result);

        return [
            'id' => 'cmpl-' . bin2hex(random_bytes(12)),
            'object' => 'text_completion',
            'created' => time(),
            'model' => $model,
            'choices' => [
                [
                    'text' => $result['output'] ?? '',
                    'index' => 0,
                    'logprobs' => null,
                    'finish_reason' => 'stop',
                ],
            ],
            'usage' => [
                'prompt_tokens' => $usage['prompt_tokens'],
                'completion_tokens' => $usage['completion_tokens'],
                'total_tokens' => $usage['total_tokens'],
            ],
        ];
    }

    public function embeddings(array|string $input, string $model): array
    {
        return [
            'error' => [
                'message' => 'Embeddings are not supported by this backend',
                'type' => 'not_implemented',
                'code' => 'not_implemented',
            ],
        ];
    }

    public function models(): array
    {
        $data = [];
        $createdAt = time();
        foreach ($this->modelService->supportedModels() as $model) {
            $data[] = [
                'id' => $model,
                'object' => 'model',
                'created' => $createdAt,
                'owned_by' => 'codex-orchestrator',
            ];
        }

        return [
            'object' => 'list',
            'data' => $data,
        ];
    }

    /**
     * @param  array<string, mixed> $runnerResult
     * @return array{prompt_tokens: int, completion_tokens: int, total_tokens: int}
     */
    private static function extractUsage(array $runnerResult): array
    {
        $prompt = (int) ($runnerResult['input_tokens'] ?? 0);
        $completion = (int) ($runnerResult['output_tokens'] ?? 0);

        return [
            'prompt_tokens' => $prompt,
            'completion_tokens' => $completion,
            'total_tokens' => $prompt + $completion,
        ];
    }

    /**
     * Send prompt to runner /exec endpoint and return the full runner result.
     *
     * @throws \RuntimeException on runner communication failure
     */
    private function runPrompt(string $prompt, ?string $model = null, array $images = [], array $params = []): array
    {
        if (trim($prompt) === '') {
            return ['status' => 'ok', 'output' => ''];
        }

        $authPayload = $this->authService->canonicalAuthSnapshot();
        if ($authPayload === null) {
            throw new \RuntimeException('No auth credentials available. Upload auth.json first.');
        }

        $payload = [
            'auth_json' => $authPayload,
            'prompt' => $prompt,
            'images' => $images,
            'model' => $model,
            'engine' => Engine::CODEX,
            'timeout_seconds' => $this->timeout,
        ];

        foreach (['max_tokens', 'temperature', 'top_p', 'stop_sequences', 'system'] as $key) {
            if (isset($params[$key])) {
                $payload[$key] = $params[$key];
            }
        }

        $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);

        $result = $this->attemptRequest($body);

        if (($result['status'] ?? '') === 'ok') {
            return $result;
        }

        $error = $result['error'] ?? $result['reason'] ?? $result['detail'] ?? 'Runner execution failed';
        throw new \RuntimeException((string) $error);
    }

    /**
     * @param array<int, array{role?: mixed, content?: mixed}> $messages
     * @return array{0: string, 1: list<array{url: string, detail?: string}>}
     */
    private function buildPromptPayload(array $messages): array
    {
        $lines = [];
        $images = [];
        $imageNumber = 1;

        foreach ($messages as $message) {
            if (!is_array($message)) {
                continue;
            }

            $role = is_string($message['role'] ?? null) && trim((string) $message['role']) !== ''
                ? trim((string) $message['role'])
                : 'user';
            $content = $this->renderMessageContent($message['content'] ?? null, $images, $imageNumber);

            if ($content === '') {
                continue;
            }

            $lines[] = "{$role}: {$content}";
        }

        return [implode("\n", $lines), $images];
    }

    /**
     * @param list<array{url: string, detail?: string}> $images
     */
    private function renderMessageContent(mixed $content, array &$images, int &$imageNumber): string
    {
        if (is_string($content)) {
            return trim($content);
        }

        if (!is_array($content)) {
            return '';
        }

        if (array_key_exists('type', $content) || array_key_exists('text', $content) || array_key_exists('image_url', $content)) {
            $content = [$content];
        }

        $parts = [];
        foreach ($content as $part) {
            if (is_string($part)) {
                $value = trim($part);
                if ($value !== '') {
                    $parts[] = $value;
                }
                continue;
            }

            if (!is_array($part)) {
                continue;
            }

            $type = strtolower((string) ($part['type'] ?? ''));
            if ($type === 'text') {
                $text = $part['text'] ?? null;
                if (is_string($text) && trim($text) !== '') {
                    $parts[] = trim($text);
                }
                continue;
            }

            if ($type !== 'image_url') {
                continue;
            }

            $imageUrl = $part['image_url'] ?? null;
            if (!is_array($imageUrl)) {
                continue;
            }

            $url = $imageUrl['url'] ?? null;
            if (!is_string($url) || trim($url) === '') {
                continue;
            }

            $image = ['url' => trim($url)];
            $detail = $imageUrl['detail'] ?? null;
            if (is_string($detail) && trim($detail) !== '') {
                $image['detail'] = trim($detail);
            }

            $images[] = $image;
            $parts[] = '[Image ' . $imageNumber . ' attached]';
            $imageNumber++;
        }

        return implode("\n", $parts);
    }

    protected function attemptRequest(string $body): array
    {
        try {
            $headers = "Content-Type: application/json\r\n";
            if (trim($this->sharedSecret) !== '') {
                $headers .= 'X-Runner-Auth: ' . trim($this->sharedSecret) . "\r\n";
            }

            $context = stream_context_create([
                'http' => [
                    'method' => 'POST',
                    'header' => $headers,
                    'content' => $body,
                    'timeout' => $this->timeout + 5.0,
                    'ignore_errors' => true,
                ],
            ]);

            $response = file_get_contents($this->runnerExecUrl, false, $context);
            if ($response === false) {
                return [
                    'status' => 'fail',
                    'error' => 'Runner request failed',
                ];
            }

            $decoded = json_decode($response, true);
            if (!is_array($decoded)) {
                return [
                    'status' => 'fail',
                    'error' => 'Invalid runner response',
                ];
            }

            return $decoded;
        } catch (Throwable $exception) {
            return [
                'status' => 'fail',
                'error' => $exception->getMessage(),
            ];
        }
    }
}
