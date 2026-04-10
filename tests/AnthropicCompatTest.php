<?php

declare(strict_types=1);

use App\Http\AnthropicCompat;
use PHPUnit\Framework\TestCase;

final class AnthropicCompatTest extends TestCase
{
    public function testNormalizeChatMessagesWithSimpleStringContent(): void
    {
        $messages = AnthropicCompat::normalizeChatMessages([
            ['role' => 'user', 'content' => 'Hello, Claude!'],
        ]);

        $this->assertSame([
            ['role' => 'user', 'content' => 'Hello, Claude!'],
        ], $messages);
    }

    public function testNormalizeChatMessagesWithContentPartArrays(): void
    {
        $messages = AnthropicCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'What is in this image?'],
                    ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => 'image/png', 'data' => 'iVBOR']],
                ],
            ],
        ]);

        $this->assertIsArray($messages);
        $this->assertCount(1, $messages);
        $this->assertSame('user', $messages[0]['role']);
        $this->assertIsArray($messages[0]['content']);
        $this->assertCount(2, $messages[0]['content']);
    }

    public function testNormalizeChatMessagesReturnsNullForEmptyInput(): void
    {
        $this->assertNull(AnthropicCompat::normalizeChatMessages([]));
    }

    public function testNormalizeChatMessagesReturnsNullForInvalidInput(): void
    {
        $this->assertNull(AnthropicCompat::normalizeChatMessages('not an array'));
    }

    public function testExtractSystemMessagesSeparatesSystemRole(): void
    {
        $messages = [
            ['role' => 'system', 'content' => 'You are helpful.'],
            ['role' => 'user', 'content' => 'Hello'],
        ];

        $result = AnthropicCompat::extractSystemMessages($messages);

        $this->assertIsArray($result);
        $this->assertArrayHasKey('system', $result);
        $this->assertArrayHasKey('messages', $result);
        $this->assertStringContainsString('You are helpful.', $result['system']);
        $hasUser = false;
        foreach ($result['messages'] as $msg) {
            if (($msg['role'] ?? '') === 'user') {
                $hasUser = true;
            }
            $this->assertNotSame('system', $msg['role'] ?? '');
        }
        $this->assertTrue($hasUser);
    }

    public function testExtractSystemMessagesHandlesDeveloperRoleAsSystem(): void
    {
        $messages = [
            ['role' => 'developer', 'content' => 'Be concise.'],
            ['role' => 'user', 'content' => 'Hi'],
        ];

        $result = AnthropicCompat::extractSystemMessages($messages);

        $this->assertIsArray($result);
        $this->assertArrayHasKey('system', $result);
        $this->assertStringContainsString('Be concise.', $result['system']);
    }

    public function testNormalizeContentPartHandlesTextTypes(): void
    {
        $messages = AnthropicCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Hello'],
                    ['type' => 'input_text', 'text' => 'from OpenAI'],
                    ['type' => 'output_text', 'text' => 'response'],
                ],
            ],
        ]);

        $this->assertIsArray($messages);
        $this->assertCount(1, $messages);
        $content = $messages[0]['content'];
        $this->assertIsArray($content);
        $textValues = [];
        foreach ($content as $part) {
            if (is_array($part) && isset($part['text'])) {
                $textValues[] = $part['text'];
            }
        }
        $this->assertContains('Hello', $textValues);
        $this->assertContains('from OpenAI', $textValues);
        $this->assertContains('response', $textValues);
    }

    public function testNormalizeContentPartConvertsOpenAiImageUrlToAnthropicImage(): void
    {
        $messages = AnthropicCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Describe this.'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'https://example.test/cat.png']],
                ],
            ],
        ]);

        $this->assertIsArray($messages);
        $content = $messages[0]['content'];
        $this->assertIsArray($content);
        $hasImage = false;
        foreach ($content as $part) {
            if (is_array($part)) {
                $type = $part['type'] ?? '';
                if ($type === 'image' || $type === 'image_url') {
                    $hasImage = true;
                }
            }
        }
        $this->assertTrue($hasImage, 'Expected an image content part in the normalized output');
    }

    public function testNormalizeContentPartHandlesAnthropicNativeImageWithBase64(): void
    {
        $messages = AnthropicCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Look at this.'],
                    [
                        'type' => 'image',
                        'source' => [
                            'type' => 'base64',
                            'media_type' => 'image/jpeg',
                            'data' => '/9j/4AAQSkZJRg==',
                        ],
                    ],
                ],
            ],
        ]);

        $this->assertIsArray($messages);
        $content = $messages[0]['content'];
        $this->assertIsArray($content);
        $this->assertGreaterThanOrEqual(2, count($content));
    }

    public function testNormalizeContentPartHandlesAnthropicNativeImageWithUrl(): void
    {
        $messages = AnthropicCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    [
                        'type' => 'image',
                        'source' => [
                            'type' => 'url',
                            'url' => 'https://example.test/photo.jpg',
                        ],
                    ],
                ],
            ],
        ]);

        $this->assertIsArray($messages);
        $this->assertCount(1, $messages);
    }

    public function testMessageStreamEventsProducesSixEventsInCorrectOrder(): void
    {
        $events = AnthropicCompat::messageStreamEvents([
            'id' => 'msg_test123',
            'type' => 'message',
            'role' => 'assistant',
            'model' => 'claude-sonnet-4-20250514',
            'content' => [
                ['type' => 'text', 'text' => 'Hello!'],
            ],
            'usage' => [
                'input_tokens' => 10,
                'output_tokens' => 5,
            ],
        ]);

        $this->assertIsArray($events);
        $this->assertCount(6, $events);

        $eventTypes = array_map(static fn(array $e): string => $e['type'] ?? '', $events);
        $this->assertSame('message_start', $eventTypes[0]);
        $this->assertSame('content_block_start', $eventTypes[1]);
        $this->assertSame('content_block_delta', $eventTypes[2]);
        $this->assertSame('content_block_stop', $eventTypes[3]);
        $this->assertSame('message_delta', $eventTypes[4]);
        $this->assertSame('message_stop', $eventTypes[5]);
    }

    public function testMessageStreamEventsPreservesMessageIdAndModel(): void
    {
        $events = AnthropicCompat::messageStreamEvents([
            'id' => 'msg_custom_id',
            'type' => 'message',
            'role' => 'assistant',
            'model' => 'claude-opus-4-20250514',
            'content' => [
                ['type' => 'text', 'text' => 'Test'],
            ],
            'usage' => [
                'input_tokens' => 5,
                'output_tokens' => 2,
            ],
        ]);

        $startEvent = $events[0];
        $this->assertSame('message_start', $startEvent['type']);
        $message = $startEvent['message'] ?? [];
        $this->assertSame('msg_custom_id', $message['id'] ?? null);
        $this->assertSame('claude-opus-4-20250514', $message['model'] ?? null);
    }

    public function testNormalizeChatMessagesPreservesMultipleMessages(): void
    {
        $messages = AnthropicCompat::normalizeChatMessages([
            ['role' => 'user', 'content' => 'First message'],
            ['role' => 'assistant', 'content' => 'First reply'],
            ['role' => 'user', 'content' => 'Second message'],
        ]);

        $this->assertIsArray($messages);
        $this->assertCount(3, $messages);
        $this->assertSame('user', $messages[0]['role']);
        $this->assertSame('assistant', $messages[1]['role']);
        $this->assertSame('user', $messages[2]['role']);
    }
}
