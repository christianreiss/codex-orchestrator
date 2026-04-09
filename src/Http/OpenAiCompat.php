<?php

declare(strict_types=1);

namespace App\Http;

final class OpenAiCompat
{
    /**
     * @return list<array{role:string, content:string|list<array<string, mixed>>}>|null
     */
    public static function normalizeChatMessages(mixed $messages): ?array
    {
        if (!is_array($messages) || $messages === []) {
            return null;
        }

        $normalized = [];
        foreach ($messages as $entry) {
            if (!is_array($entry)) {
                continue;
            }

            $content = self::normalizeMessageContent($entry['content'] ?? null);
            if ($content === null) {
                continue;
            }

            $normalized[] = [
                'role' => self::normalizeRole($entry['role'] ?? null),
                'content' => $content,
            ];
        }

        return $normalized !== [] ? $normalized : null;
    }

    /**
     * @return list<array{role:string, content:string|list<array<string, mixed>>}>|null
     */
    public static function normalizeResponsesInput(mixed $input, mixed $instructions = null): ?array
    {
        $messages = [];
        $inputMessages = [];

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

                $inputMessages[] = [
                    'role' => 'user',
                    'content' => $content,
                ];
                continue;
            }

            if (!is_array($entry)) {
                continue;
            }

            $role = self::normalizeRole($entry['role'] ?? null);
            $content = self::normalizeMessageContent($entry['content'] ?? null);

            if (($entry['type'] ?? null) === 'message' && $content !== null) {
                $inputMessages[] = [
                    'role' => $role,
                    'content' => $content,
                ];
                continue;
            }

            if ($content !== null && isset($entry['role'])) {
                $inputMessages[] = [
                    'role' => $role,
                    'content' => $content,
                ];
            }
        }

        if ($inputMessages === []) {
            $content = self::normalizeMessageContent($input);
            if ($content !== null) {
                $inputMessages[] = [
                    'role' => 'user',
                    'content' => $content,
                ];
            }
        }

        $messages = [...$messages, ...$inputMessages];

        return $messages !== [] ? $messages : null;
    }

    public static function responseFromChatCompletion(array $completion): array
    {
        $responseId = self::deriveId((string) ($completion['id'] ?? ''), 'resp_');
        $messageId = self::deriveId((string) ($completion['id'] ?? ''), 'msg_');
        $createdAt = (int) ($completion['created'] ?? time());
        $model = (string) ($completion['model'] ?? '');
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
        $model = (string) ($completion['model'] ?? '');
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

    /**
     * @return string|list<array<string, mixed>>|null
     */
    private static function normalizeMessageContent(mixed $content): string|array|null
    {
        if (is_string($content)) {
            $value = trim($content);
            return $value !== '' ? $value : null;
        }

        if (!is_array($content)) {
            return null;
        }

        if (self::looksLikeSingleContentPart($content)) {
            $content = [$content];
        }

        $parts = [];
        foreach ($content as $part) {
            if (is_string($part)) {
                $value = trim($part);
                if ($value !== '') {
                    $parts[] = [
                        'type' => 'text',
                        'text' => $value,
                    ];
                }
                continue;
            }

            if (!is_array($part)) {
                continue;
            }

            $normalized = self::normalizeContentPart($part);
            if ($normalized !== null) {
                $parts[] = $normalized;
            }
        }

        if ($parts === []) {
            return null;
        }

        if (count($parts) === 1 && ($parts[0]['type'] ?? null) === 'text' && is_string($parts[0]['text'] ?? null)) {
            return $parts[0]['text'];
        }

        return $parts;
    }

    private static function looksLikeSingleContentPart(array $content): bool
    {
        return array_key_exists('type', $content)
            || array_key_exists('text', $content)
            || array_key_exists('image_url', $content);
    }

    /**
     * @return array<string, mixed>|null
     */
    private static function normalizeContentPart(array $part): ?array
    {
        $type = strtolower((string) ($part['type'] ?? ''));
        if (in_array($type, ['input_text', 'text', 'output_text'], true)) {
            $text = $part['text'] ?? null;
            if (!is_string($text)) {
                return null;
            }

            $value = trim($text);
            if ($value === '') {
                return null;
            }

            return [
                'type' => 'text',
                'text' => $value,
            ];
        }

        if (in_array($type, ['image_url', 'input_image'], true)) {
            $imageUrl = $part['image_url'] ?? null;
            $url = null;
            $detail = null;

            if (is_array($imageUrl)) {
                $url = $imageUrl['url'] ?? null;
                $detail = $imageUrl['detail'] ?? ($part['detail'] ?? null);
            } else {
                $url = $imageUrl;
                $detail = $part['detail'] ?? null;
            }

            if (!is_string($url) || trim($url) === '') {
                return null;
            }

            $normalized = [
                'type' => 'image_url',
                'image_url' => [
                    'url' => trim($url),
                ],
            ];

            if (is_string($detail) && trim($detail) !== '') {
                $normalized['image_url']['detail'] = trim($detail);
            }

            return $normalized;
        }

        return null;
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
