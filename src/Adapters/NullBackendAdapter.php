<?php

declare(strict_types=1);

namespace App\Adapters;

use App\Contracts\BackendAdapter;

class NullBackendAdapter implements BackendAdapter
{
    public function chatCompletions(array $messages, string $model, array $params = []): array
    {
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
                        'content' => 'Backend adapter not implemented yet.',
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

    public function messages(array $messages, string $model, array $params = []): array
    {
        return [
            'id' => 'msg_' . bin2hex(random_bytes(16)),
            'type' => 'message',
            'role' => 'assistant',
            'content' => [
                [
                    'type' => 'text',
                    'text' => 'Backend adapter not implemented yet.',
                ],
            ],
            'model' => $model,
            'stop_reason' => 'end_turn',
            'stop_sequence' => null,
            'usage' => [
                'input_tokens' => 0,
                'output_tokens' => 0,
                'cache_creation_input_tokens' => 0,
                'cache_read_input_tokens' => 0,
            ],
        ];
    }

    public function completions(string $prompt, string $model, array $params = []): array
    {
        return [
            'id' => 'cmpl-' . bin2hex(random_bytes(12)),
            'object' => 'text_completion',
            'created' => time(),
            'model' => $model,
            'choices' => [
                [
                    'text' => 'Backend adapter not implemented yet.',
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
            'object' => 'list',
            'data' => [
                [
                    'object' => 'embedding',
                    'index' => 0,
                    'embedding' => [],
                ],
            ],
            'model' => $model,
            'usage' => [
                'prompt_tokens' => 0,
                'total_tokens' => 0,
            ],
        ];
    }

    public function models(): array
    {
        return [
            'object' => 'list',
            'data' => [
                [
                    'id' => 'placeholder-model',
                    'object' => 'model',
                    'created' => time(),
                    'owned_by' => 'you',
                ],
            ],
        ];
    }
}
