<?php

declare(strict_types=1);

use App\Http\OpenAiCompat;
use PHPUnit\Framework\TestCase;

final class OpenAiApiCompatibilityTest extends TestCase
{
    public function testNormalizeResponsesInputSupportsStringMessagesAndInstructions(): void
    {
        $messages = OpenAiCompat::normalizeResponsesInput(
            [
                [
                    'type' => 'message',
                    'role' => 'user',
                    'content' => [
                        ['type' => 'input_text', 'text' => 'Reply with'],
                        ['type' => 'text', 'text' => 'exactly pong'],
                    ],
                ],
            ],
            'Be terse.'
        );

        $this->assertSame([
            ['role' => 'system', 'content' => 'Be terse.'],
            ['role' => 'user', 'content' => [
                ['type' => 'text', 'text' => 'Reply with'],
                ['type' => 'text', 'text' => 'exactly pong'],
            ]],
        ], $messages);
    }

    public function testNormalizeChatMessagesKeepsImageContentParts(): void
    {
        $messages = OpenAiCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'What is in this image?'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'https://example.test/cat.png', 'detail' => 'high']],
                ],
            ],
        ]);

        $this->assertSame([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'What is in this image?'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'https://example.test/cat.png', 'detail' => 'high']],
                ],
            ],
        ], $messages);
    }

    public function testNormalizeResponsesInputSupportsBareContentPartArrays(): void
    {
        $messages = OpenAiCompat::normalizeResponsesInput([
            ['type' => 'input_text', 'text' => 'Inspect this.'],
            ['type' => 'input_image', 'image_url' => 'data:image/png;base64,Zm9v'],
        ]);

        $this->assertSame([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Inspect this.'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'data:image/png;base64,Zm9v']],
                ],
            ],
        ], $messages);
    }

    public function testResponseShimMapsChatCompletionIntoResponseObject(): void
    {
        $response = OpenAiCompat::responseFromChatCompletion([
            'id' => 'chatcmpl-abc123',
            'object' => 'chat.completion',
            'created' => 1710000000,
            'model' => 'gpt-5.4',
            'choices' => [
                [
                    'index' => 0,
                    'message' => [
                        'role' => 'assistant',
                        'content' => 'pong',
                    ],
                    'finish_reason' => 'stop',
                ],
            ],
            'usage' => [
                'prompt_tokens' => 12,
                'completion_tokens' => 3,
                'total_tokens' => 15,
            ],
        ]);

        $this->assertSame('response', $response['object']);
        $this->assertSame('resp_abc123', $response['id']);
        $this->assertSame('completed', $response['status']);
        $this->assertSame('pong', $response['output'][0]['content'][0]['text']);
        $this->assertSame(12, $response['usage']['input_tokens']);
        $this->assertSame(3, $response['usage']['output_tokens']);
        $this->assertSame(15, $response['usage']['total_tokens']);
    }

    public function testChatStreamingUsesDeltaChunks(): void
    {
        $events = OpenAiCompat::chatCompletionStreamEvents([
            'id' => 'chatcmpl-abc123',
            'created' => 1710000000,
            'model' => 'gpt-5.4',
            'choices' => [
                [
                    'message' => [
                        'role' => 'assistant',
                        'content' => 'pong',
                    ],
                ],
            ],
        ]);

        $this->assertCount(3, $events);
        $this->assertSame('chat.completion.chunk', $events[0]['data']['object']);
        $this->assertSame('assistant', $events[0]['data']['choices'][0]['delta']['role']);
        $this->assertSame('pong', $events[1]['data']['choices'][0]['delta']['content']);
        $this->assertSame('stop', $events[2]['data']['choices'][0]['finish_reason']);
        $this->assertEquals(new stdClass(), $events[2]['data']['choices'][0]['delta']);
    }

    public function testRouterAndDocsAdvertiseResponsesEndpoint(): void
    {
        $routerSource = file_get_contents(__DIR__ . '/../public/index.php');
        $adminSource = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $apiDoc = file_get_contents(__DIR__ . '/../docs/interface-api.md');

        $this->assertIsString($routerSource);
        $this->assertIsString($adminSource);
        $this->assertIsString($apiDoc);

        $this->assertStringContainsString("#^/v1/responses$#", $routerSource);
        $this->assertStringContainsString('/v1/responses', $adminSource);
        $this->assertStringContainsString('POST /v1/responses', $apiDoc);
    }
}
