<?php

declare(strict_types=1);

namespace App\Adapters;

use App\Contracts\BackendAdapter;
use App\Services\AuthService;
use App\Services\OpenAiModelService;
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

    public function chatCompletions(array $messages, string $model): array
    {
        $lines = [];
        foreach ($messages as $message) {
            $role = $message['role'] ?? 'user';
            $content = $message['content'] ?? '';
            $lines[] = "{$role}: {$content}";
        }
        $prompt = implode("\n", $lines);

        $output = $this->runPrompt($prompt, $model);

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
                        'content' => $output,
                    ],
                    'finish_reason' => 'stop',
                ],
            ],
            'usage' => [
                'prompt_tokens' => 0,
                'completion_tokens' => 0,
                'total_tokens' => 0,
            ],
        ];
    }

    public function completions(string $prompt, string $model): array
    {
        $output = $this->runPrompt($prompt, $model);

        return [
            'id' => 'cmpl-' . bin2hex(random_bytes(12)),
            'object' => 'text_completion',
            'created' => time(),
            'model' => $model,
            'choices' => [
                [
                    'text' => $output,
                    'index' => 0,
                    'logprobs' => null,
                    'finish_reason' => 'stop',
                ],
            ],
            'usage' => [
                'prompt_tokens' => 0,
                'completion_tokens' => 0,
                'total_tokens' => 0,
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
     * Send prompt to runner /exec endpoint and return the output text.
     *
     * @throws \RuntimeException on runner communication failure
     */
    private function runPrompt(string $prompt, ?string $model = null): string
    {
        if (trim($prompt) === '') {
            return '';
        }

        $authPayload = $this->authService->canonicalAuthSnapshot();
        if ($authPayload === null) {
            throw new \RuntimeException('No auth credentials available. Upload auth.json first.');
        }

        $body = json_encode([
            'auth_json' => $authPayload,
            'prompt' => $prompt,
            'model' => $model,
            'timeout_seconds' => $this->timeout,
        ], JSON_UNESCAPED_SLASHES);

        $result = $this->attemptRequest($body);

        if (($result['status'] ?? '') === 'ok') {
            return $result['output'] ?? '';
        }

        $error = $result['error'] ?? $result['reason'] ?? 'Runner execution failed';
        throw new \RuntimeException((string) $error);
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
