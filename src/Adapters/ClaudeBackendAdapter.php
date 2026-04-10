<?php

declare(strict_types=1);

namespace App\Adapters;

use App\Services\AuthService;
use App\Services\ClaudeModelService;
use App\Support\Engine;
use Throwable;

class ClaudeBackendAdapter
{
    public function __construct(
        private readonly string $runnerExecUrl,
        private readonly string $sharedSecret,
        private readonly AuthService $authService,
        private readonly ClaudeModelService $modelService,
        private readonly float $timeout = 30.0
    ) {
    }

    public function messages(array $messages, string $model): array
    {
        [$prompt, $images] = $this->buildPromptPayload($messages);

        $output = $this->runPrompt($prompt, $model, $images);

        return [
            'id' => 'msg_' . bin2hex(random_bytes(16)),
            'type' => 'message',
            'role' => 'assistant',
            'content' => [
                [
                    'type' => 'text',
                    'text' => $output,
                ],
            ],
            'model' => $model,
            'stop_reason' => 'end_turn',
            'stop_sequence' => null,
            'usage' => [
                'input_tokens' => 0,
                'output_tokens' => 0,
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
                'owned_by' => 'anthropic',
            ];
        }

        return [
            'data' => $data,
            'object' => 'list',
        ];
    }

    private function runPrompt(string $prompt, ?string $model = null, array $images = []): string
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
            'images' => $images,
            'model' => $model,
            'engine' => Engine::CLAUDE,
            'timeout_seconds' => $this->timeout,
        ], JSON_UNESCAPED_SLASHES);

        $result = $this->attemptRequest($body);

        if (($result['status'] ?? '') === 'ok') {
            return $result['output'] ?? '';
        }

        $error = $result['error'] ?? $result['reason'] ?? $result['detail'] ?? 'Runner execution failed';
        throw new \RuntimeException((string) $error);
    }

    /**
     * @return array{0: string, 1: list<array{url: string}>}
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
     * @param list<array{url: string}> $images
     */
    private function renderMessageContent(mixed $content, array &$images, int &$imageNumber): string
    {
        if (is_string($content)) {
            return trim($content);
        }

        if (!is_array($content)) {
            return '';
        }

        if (array_key_exists('type', $content) || array_key_exists('text', $content) || array_key_exists('source', $content)) {
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

            if ($type !== 'image') {
                continue;
            }

            $source = $part['source'] ?? null;
            if (!is_array($source)) {
                continue;
            }

            $sourceType = $source['type'] ?? null;
            if ($sourceType === 'base64') {
                $mediaType = $source['media_type'] ?? 'image/png';
                $data = $source['data'] ?? null;
                if (!is_string($data) || trim($data) === '') {
                    continue;
                }
                $url = 'data:' . $mediaType . ';base64,' . $data;
            } elseif ($sourceType === 'url') {
                $url = $source['url'] ?? null;
                if (!is_string($url) || trim($url) === '') {
                    continue;
                }
            } else {
                continue;
            }

            $images[] = ['url' => $url];
            $parts[] = '[Image ' . $imageNumber . ' attached]';
            $imageNumber++;
        }

        return implode("\n", $parts);
    }

    private function attemptRequest(string $body): array
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
