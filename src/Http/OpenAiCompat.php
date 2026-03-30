<?php

declare(strict_types=1);

namespace App\Http;

final class OpenAiCompat
{
    /**
     * @return list<array{role:string, content:string}>|null
     */
    public static function normalizeResponsesInput(mixed $input, mixed $instructions = null): ?array
    {
        $messages = [];

        if (is_string($instructions) && trim($instructions) !== '') {
            $messages[] = [
                'role' => 'system',
                'content' => trim($instructions),
            ];
        }

        if (is_string($input)) {
            $content = trim($input);
            if ($content === '') {
                return null;
            }

            $messages[] = [
                'role' => 'user',
                'content' => $content,
            ];

            return $messages;
        }

        if (!is_array($input)) {
            return null;
        }

        foreach ($input as $entry) {
            if (is_string($entry)) {
                $content = trim($entry);
                if ($content === '') {
                    continue;
                }

                $messages[] = [
                    'role' => 'user',
                    'content' => $content,
                ];
                continue;
            }

            if (!is_array($entry)) {
                continue;
            }

            $role = self::normalizeRole($entry['role'] ?? null);
            $content = self::flattenMessageContent($entry['content'] ?? null);

            if (($entry['type'] ?? null) === 'message' && $content !== null) {
                $messages[] = [
                    'role' => $role,
                    'content' => $content,
                ];
                continue;
            }

            if ($content !== null && isset($entry['role'])) {
                $messages[] = [
                    'role' => $role,
                    'content' => $content,
                ];
            }
        }

        return $messages !== [] ? $messages : null;
    }

    public static function responseFromChatCompletion(array $completion): array
    {
        $responseId = self::deriveId((string) ($completion['id'] ?? ''), 'resp_');
        $messageId = self::deriveId((string) ($completion['id'] ?? ''), 'msg_');
        $createdAt = (int) ($completion['created'] ?? time());
        $model = (string) ($completion['model'] ?? 'cdx-lm-1');
        $content = self::extractChatCompletionContent($completion);
        $usage = is_array($completion['usage'] ?? null) ? $completion['usage'] : [];

        return [
            'id' => $responseId,
            'object' => 'response',
            'created_at' => $createdAt,
            'status' => 'completed',
            'model' => $model,
            'output' => [
                [
                    'id' => $messageId,
                    'type' => 'message',
                    'status' => 'completed',
                    'role' => 'assistant',
                    'content' => [
                        [
                            'type' => 'output_text',
                            'text' => $content,
                            'annotations' => [],
                            'logprobs' => [],
                        ],
                    ],
                ],
            ],
            'parallel_tool_calls' => false,
            'usage' => [
                'input_tokens' => (int) ($usage['prompt_tokens'] ?? 0),
                'output_tokens' => (int) ($usage['completion_tokens'] ?? 0),
                'output_tokens_details' => [
                    'reasoning_tokens' => 0,
                ],
                'total_tokens' => (int) ($usage['total_tokens'] ?? 0),
            ],
        ];
    }

    /**
     * @return list<array{data: array}>
     */
    public static function chatCompletionStreamEvents(array $completion): array
    {
        $id = (string) ($completion['id'] ?? ('chatcmpl-' . bin2hex(random_bytes(12))));
        $created = (int) ($completion['created'] ?? time());
        $model = (string) ($completion['model'] ?? 'cdx-lm-1');
        $content = self::extractChatCompletionContent($completion);

        $base = [
            'id' => $id,
            'object' => 'chat.completion.chunk',
            'created' => $created,
            'model' => $model,
        ];

        $events = [
            [
                'data' => $base + [
                    'choices' => [
                        [
                            'index' => 0,
                            'delta' => [
                                'role' => 'assistant',
                                'content' => '',
                            ],
                            'finish_reason' => null,
                        ],
                    ],
                ],
            ],
        ];

        if ($content !== '') {
            $events[] = [
                'data' => $base + [
                    'choices' => [
                        [
                            'index' => 0,
                            'delta' => [
                                'content' => $content,
                            ],
                            'finish_reason' => null,
                        ],
                    ],
                ],
            ];
        }

        $events[] = [
            'data' => $base + [
                'choices' => [
                    [
                        'index' => 0,
                        'delta' => (object) [],
                        'finish_reason' => 'stop',
                    ],
                ],
            ],
        ];

        return $events;
    }

    private static function extractChatCompletionContent(array $completion): string
    {
        $choices = $completion['choices'] ?? null;
        if (!is_array($choices) || !is_array($choices[0] ?? null)) {
            return '';
        }

        $message = $choices[0]['message'] ?? null;
        if (!is_array($message)) {
            return '';
        }

        $content = $message['content'] ?? '';
        return is_string($content) ? $content : '';
    }

    private static function normalizeRole(mixed $role): string
    {
        $normalized = is_string($role) ? strtolower(trim($role)) : 'user';
        return in_array($normalized, ['system', 'developer', 'assistant'], true) ? $normalized : 'user';
    }

    private static function flattenMessageContent(mixed $content): ?string
    {
        if (is_string($content)) {
            $value = trim($content);
            return $value !== '' ? $value : null;
        }

        if (!is_array($content)) {
            return null;
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
            $text = $part['text'] ?? null;
            if (!is_string($text)) {
                continue;
            }

            if (in_array($type, ['input_text', 'text', 'output_text'], true)) {
                $value = trim($text);
                if ($value !== '') {
                    $parts[] = $value;
                }
            }
        }

        if ($parts === []) {
            return null;
        }

        return implode("\n", $parts);
    }

    private static function deriveId(string $sourceId, string $prefix): string
    {
        $suffix = $sourceId !== '' ? preg_replace('/^[^-_]+[-_]/', '', $sourceId) : null;
        if (is_string($suffix) && $suffix !== '') {
            return $prefix . $suffix;
        }

        return $prefix . bin2hex(random_bytes(12));
    }
}
