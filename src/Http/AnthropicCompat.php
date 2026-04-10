<?php

declare(strict_types=1);

namespace App\Http;

final class AnthropicCompat
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
     * @param  list<array{role:string, content:string|list<array<string, mixed>>}> $messages
     * @return array{system: ?string, messages: list<array{role:string, content:string|list<array<string, mixed>>}>}
     */
    public static function extractSystemMessages(array $messages): array
    {
        $systemParts = [];
        $conversationMessages = [];

        foreach ($messages as $message) {
            $role = $message['role'];
            if ($role === 'system' || $role === 'developer') {
                $content = $message['content'];
                $text = is_string($content) ? $content : self::extractTextFromContentBlocks($content);
                if ($text !== '') {
                    $systemParts[] = $text;
                }
                continue;
            }

            $conversationMessages[] = $message;
        }

        return [
            'system' => $systemParts !== [] ? implode("\n\n", $systemParts) : null,
            'messages' => $conversationMessages,
        ];
    }

    /**
     * @param  array<string, mixed> $result
     * @return list<array{event: string, data: array<string, mixed>}>
     */
    public static function messageStreamEvents(array $result): array
    {
        $rawId = $result['id'] ?? null;
        $messageId = self::deriveId(is_string($rawId) ? $rawId : '', 'msg_');

        $rawModel = $result['model'] ?? null;
        $model = is_string($rawModel) ? $rawModel : 'claude-sonnet-4-20250514';

        $usage = is_array($result['usage'] ?? null) ? $result['usage'] : [];
        $rawInputTokens = $usage['input_tokens'] ?? 0;
        $inputTokens = is_int($rawInputTokens) ? $rawInputTokens : 0;
        $rawOutputTokens = $usage['output_tokens'] ?? 0;
        $outputTokens = is_int($rawOutputTokens) ? $rawOutputTokens : 0;

        $text = '';
        $content = $result['content'] ?? [];
        if (is_array($content)) {
            foreach ($content as $block) {
                if (is_array($block) && ($block['type'] ?? '') === 'text') {
                    $rawText = $block['text'] ?? '';
                    $text = is_string($rawText) ? $rawText : '';
                    break;
                }
            }
        }

        return [
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
                            'input_tokens' => $inputTokens,
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
    }

    private static function normalizeRole(mixed $role): string
    {
        $normalized = is_string($role) ? strtolower(trim($role)) : 'user';

        if ($normalized === 'system' || $normalized === 'developer') {
            return 'system';
        }

        if ($normalized === 'assistant') {
            return 'assistant';
        }

        return 'user';
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

    /**
     * @param  array<mixed> $content
     */
    private static function looksLikeSingleContentPart(array $content): bool
    {
        return array_key_exists('type', $content)
            || array_key_exists('text', $content)
            || array_key_exists('source', $content);
    }

    /**
     * @param  array<mixed> $part
     * @return array<string, mixed>|null
     */
    private static function normalizeContentPart(array $part): ?array
    {
        $rawType = $part['type'] ?? '';
        $type = is_string($rawType) ? strtolower(trim($rawType)) : '';

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

        // Anthropic-native image format: type=image with source array
        if ($type === 'image') {
            $source = $part['source'] ?? null;
            if (!is_array($source)) {
                return null;
            }

            $rawSourceType = $source['type'] ?? '';
            $sourceType = is_string($rawSourceType) ? $rawSourceType : '';
            if ($sourceType === 'base64') {
                $mediaType = $source['media_type'] ?? null;
                $data = $source['data'] ?? null;
                if (!is_string($mediaType) || !is_string($data) || $data === '') {
                    return null;
                }

                return [
                    'type' => 'image',
                    'source' => [
                        'type' => 'base64',
                        'media_type' => $mediaType,
                        'data' => $data,
                    ],
                ];
            }

            if ($sourceType === 'url') {
                $url = $source['url'] ?? null;
                if (!is_string($url) || trim($url) === '') {
                    return null;
                }

                return [
                    'type' => 'image',
                    'source' => [
                        'type' => 'url',
                        'url' => trim($url),
                    ],
                ];
            }

            return null;
        }

        // OpenAI-format images: convert to Anthropic format
        if (in_array($type, ['image_url', 'input_image'], true)) {
            $imageUrl = $part['image_url'] ?? null;
            $url = null;

            if (is_array($imageUrl)) {
                $url = $imageUrl['url'] ?? null;
            } else {
                $url = $imageUrl;
            }

            if (!is_string($url) || trim($url) === '') {
                return null;
            }

            $url = trim($url);

            // Data URL: data:image/png;base64,... -> base64 source
            if (preg_match('#^data:image/([^;]+);base64,(.+)$#', $url, $matches) === 1) {
                return [
                    'type' => 'image',
                    'source' => [
                        'type' => 'base64',
                        'media_type' => 'image/' . $matches[1],
                        'data' => $matches[2],
                    ],
                ];
            }

            // HTTP(S) URL -> url source
            if (str_starts_with($url, 'http://') || str_starts_with($url, 'https://')) {
                return [
                    'type' => 'image',
                    'source' => [
                        'type' => 'url',
                        'url' => $url,
                    ],
                ];
            }

            return null;
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

    /**
     * @param  list<array<string, mixed>> $content
     */
    private static function extractTextFromContentBlocks(array $content): string
    {
        $texts = [];
        foreach ($content as $block) {
            if (($block['type'] ?? '') === 'text' && is_string($block['text'] ?? null)) {
                $texts[] = $block['text'];
            }
        }

        return implode("\n", $texts);
    }
}
