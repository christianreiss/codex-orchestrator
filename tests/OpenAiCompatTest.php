<?php

declare(strict_types=1);

use App\Http\OpenAiCompat;
use PHPUnit\Framework\TestCase;

final class OpenAiCompatTest extends TestCase
{
    // ---------------------------------------------------------------
    // normalizeChatMessages() edge cases
    // ---------------------------------------------------------------

    public function testNormalizeChatMessagesReturnsNullForNullInput(): void
    {
        $this->assertNull(OpenAiCompat::normalizeChatMessages(null));
    }

    public function testNormalizeChatMessagesReturnsNullForEmptyArray(): void
    {
        $this->assertNull(OpenAiCompat::normalizeChatMessages([]));
    }

    public function testNormalizeChatMessagesReturnsNullForNonArray(): void
    {
        $this->assertNull(OpenAiCompat::normalizeChatMessages('hello'));
    }

    public function testNormalizeChatMessagesSingleTextMessage(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            ['role' => 'user', 'content' => 'Hello world'],
        ]);

        $this->assertSame([
            ['role' => 'user', 'content' => 'Hello world'],
        ], $result);
    }

    public function testNormalizeChatMessagesMultiPartContent(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'First part'],
                    ['type' => 'text', 'text' => 'Second part'],
                ],
            ],
        ]);

        $this->assertSame([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'First part'],
                    ['type' => 'text', 'text' => 'Second part'],
                ],
            ],
        ], $result);
    }

    public function testNormalizeChatMessagesWithImageUrlContentParts(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Describe this'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'https://example.test/img.png']],
                ],
            ],
        ]);

        $this->assertSame([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Describe this'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'https://example.test/img.png']],
                ],
            ],
        ], $result);
    }

    public function testNormalizeChatMessagesNormalizesInputImageToImageUrl(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'input_image', 'image_url' => ['url' => 'data:image/png;base64,abc']],
                ],
            ],
        ]);

        $this->assertSame([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'image_url', 'image_url' => ['url' => 'data:image/png;base64,abc']],
                ],
            ],
        ], $result);
    }

    public function testNormalizeChatMessagesNormalizesInputTextToText(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'input_text', 'text' => 'Normalized input'],
                ],
            ],
        ]);

        // Single text part collapses to a plain string
        $this->assertSame([
            ['role' => 'user', 'content' => 'Normalized input'],
        ], $result);
    }

    public function testNormalizeChatMessagesNormalizesOutputTextToText(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            [
                'role' => 'assistant',
                'content' => [
                    ['type' => 'output_text', 'text' => 'Response text'],
                ],
            ],
        ]);

        $this->assertSame([
            ['role' => 'assistant', 'content' => 'Response text'],
        ], $result);
    }

    public function testNormalizeChatMessagesMixedTextAndImage(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Look at this image:'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'https://example.test/photo.jpg', 'detail' => 'high']],
                ],
            ],
        ]);

        $this->assertSame([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Look at this image:'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'https://example.test/photo.jpg', 'detail' => 'high']],
                ],
            ],
        ], $result);
    }

    public function testNormalizeChatMessagesSkipsEntriesWithEmptyContent(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            ['role' => 'user', 'content' => ''],
            ['role' => 'user', 'content' => 'Valid message'],
        ]);

        $this->assertSame([
            ['role' => 'user', 'content' => 'Valid message'],
        ], $result);
    }

    public function testNormalizeChatMessagesSkipsNonArrayEntries(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            'not an array',
            ['role' => 'user', 'content' => 'OK'],
        ]);

        $this->assertSame([
            ['role' => 'user', 'content' => 'OK'],
        ], $result);
    }

    public function testNormalizeChatMessagesTrimsWhitespace(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            ['role' => 'user', 'content' => '  trimmed  '],
        ]);

        $this->assertSame([
            ['role' => 'user', 'content' => 'trimmed'],
        ], $result);
    }

    // ---------------------------------------------------------------
    // Role normalization (via normalizeChatMessages)
    // ---------------------------------------------------------------

    public function testRoleNormalizationPreservesSystem(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            ['role' => 'system', 'content' => 'You are helpful.'],
        ]);

        $this->assertSame('system', $result[0]['role']);
    }

    public function testRoleNormalizationPreservesDeveloper(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            ['role' => 'developer', 'content' => 'Dev context.'],
        ]);

        $this->assertSame('developer', $result[0]['role']);
    }

    public function testRoleNormalizationPreservesAssistant(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            ['role' => 'assistant', 'content' => 'I will help.'],
        ]);

        $this->assertSame('assistant', $result[0]['role']);
    }

    public function testRoleNormalizationDefaultsToUser(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            ['role' => 'user', 'content' => 'Hello'],
        ]);

        $this->assertSame('user', $result[0]['role']);
    }

    public function testRoleNormalizationUnknownRoleDefaultsToUser(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            ['role' => 'moderator', 'content' => 'Message from unknown role'],
        ]);

        $this->assertSame('user', $result[0]['role']);
    }

    public function testRoleNormalizationMissingRoleDefaultsToUser(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            ['content' => 'No role specified'],
        ]);

        $this->assertSame('user', $result[0]['role']);
    }

    public function testRoleNormalizationIsCaseInsensitive(): void
    {
        $result = OpenAiCompat::normalizeChatMessages([
            ['role' => 'SYSTEM', 'content' => 'Case test'],
        ]);

        $this->assertSame('system', $result[0]['role']);
    }

    // ---------------------------------------------------------------
    // normalizeResponsesInput()
    // ---------------------------------------------------------------

    public function testNormalizeResponsesInputStringCreatesUserMessage(): void
    {
        $result = OpenAiCompat::normalizeResponsesInput('Hello there');

        $this->assertSame([
            ['role' => 'user', 'content' => 'Hello there'],
        ], $result);
    }

    public function testNormalizeResponsesInputContentPartsCreateUserMessage(): void
    {
        $result = OpenAiCompat::normalizeResponsesInput([
            ['type' => 'input_text', 'text' => 'Part one'],
            ['type' => 'input_text', 'text' => 'Part two'],
        ]);

        $this->assertSame([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Part one'],
                    ['type' => 'text', 'text' => 'Part two'],
                ],
            ],
        ], $result);
    }

    public function testNormalizeResponsesInputArrayOfMessagesPreservesRoles(): void
    {
        $result = OpenAiCompat::normalizeResponsesInput([
            [
                'type' => 'message',
                'role' => 'user',
                'content' => 'First message',
            ],
            [
                'type' => 'message',
                'role' => 'assistant',
                'content' => 'Reply',
            ],
        ]);

        $this->assertSame([
            ['role' => 'user', 'content' => 'First message'],
            ['role' => 'assistant', 'content' => 'Reply'],
        ], $result);
    }

    public function testNormalizeResponsesInputInstructionsCreateSystemMessage(): void
    {
        $result = OpenAiCompat::normalizeResponsesInput('User question', 'Be concise.');

        $this->assertSame([
            ['role' => 'system', 'content' => 'Be concise.'],
            ['role' => 'user', 'content' => 'User question'],
        ], $result);
    }

    public function testNormalizeResponsesInputReturnsNullForNull(): void
    {
        $this->assertNull(OpenAiCompat::normalizeResponsesInput(null));
    }

    public function testNormalizeResponsesInputReturnsNullForEmptyString(): void
    {
        $this->assertNull(OpenAiCompat::normalizeResponsesInput('   '));
    }

    public function testNormalizeResponsesInputReturnsNullForEmptyArray(): void
    {
        $this->assertNull(OpenAiCompat::normalizeResponsesInput([]));
    }

    public function testNormalizeResponsesInputIgnoresBlankInstructions(): void
    {
        $result = OpenAiCompat::normalizeResponsesInput('Hello', '   ');

        $this->assertSame([
            ['role' => 'user', 'content' => 'Hello'],
        ], $result);
    }

    public function testNormalizeResponsesInputWithImageContentParts(): void
    {
        $result = OpenAiCompat::normalizeResponsesInput([
            ['type' => 'input_text', 'text' => 'Describe this.'],
            ['type' => 'input_image', 'image_url' => 'data:image/png;base64,Zm9v'],
        ]);

        $this->assertSame([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Describe this.'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'data:image/png;base64,Zm9v']],
                ],
            ],
        ], $result);
    }

    // ---------------------------------------------------------------
    // responseFromChatCompletion()
    // ---------------------------------------------------------------

    public function testResponseFromChatCompletionConvertsFormat(): void
    {
        $response = OpenAiCompat::responseFromChatCompletion([
            'id' => 'chatcmpl-xyz789',
            'object' => 'chat.completion',
            'created' => 1710000000,
            'model' => 'gpt-5.4',
            'choices' => [
                [
                    'index' => 0,
                    'message' => ['role' => 'assistant', 'content' => 'Hello!'],
                    'finish_reason' => 'stop',
                ],
            ],
            'usage' => [
                'prompt_tokens' => 10,
                'completion_tokens' => 5,
                'total_tokens' => 15,
            ],
        ]);

        $this->assertSame('response', $response['object']);
        $this->assertSame('completed', $response['status']);
        $this->assertSame('gpt-5.4', $response['model']);
        $this->assertSame(1710000000, $response['created_at']);
    }

    public function testResponseFromChatCompletionExtractsTextFromFirstChoice(): void
    {
        $response = OpenAiCompat::responseFromChatCompletion([
            'id' => 'chatcmpl-test1',
            'choices' => [
                ['message' => ['content' => 'First choice response']],
                ['message' => ['content' => 'Second choice ignored']],
            ],
        ]);

        $this->assertSame('First choice response', $response['output'][0]['content'][0]['text']);
        $this->assertSame('output_text', $response['output'][0]['content'][0]['type']);
    }

    public function testResponseFromChatCompletionMapsUsageFields(): void
    {
        $response = OpenAiCompat::responseFromChatCompletion([
            'id' => 'chatcmpl-usage1',
            'usage' => [
                'prompt_tokens' => 42,
                'completion_tokens' => 18,
                'total_tokens' => 60,
            ],
        ]);

        $this->assertSame(42, $response['usage']['input_tokens']);
        $this->assertSame(18, $response['usage']['output_tokens']);
        $this->assertSame(60, $response['usage']['total_tokens']);
        $this->assertSame(0, $response['usage']['output_tokens_details']['reasoning_tokens']);
    }

    public function testResponseFromChatCompletionGeneratesProperIds(): void
    {
        $response = OpenAiCompat::responseFromChatCompletion([
            'id' => 'chatcmpl-abc123def',
        ]);

        $this->assertStringStartsWith('resp_', $response['id']);
        $this->assertStringStartsWith('msg_', $response['output'][0]['id']);
    }

    public function testResponseFromChatCompletionHandlesMissingChoices(): void
    {
        $response = OpenAiCompat::responseFromChatCompletion([
            'id' => 'chatcmpl-empty',
        ]);

        $this->assertSame('', $response['output'][0]['content'][0]['text']);
    }

    public function testResponseFromChatCompletionOutputStructure(): void
    {
        $response = OpenAiCompat::responseFromChatCompletion([
            'id' => 'chatcmpl-struct',
            'choices' => [
                ['message' => ['content' => 'Test']],
            ],
        ]);

        $output = $response['output'][0];
        $this->assertSame('message', $output['type']);
        $this->assertSame('completed', $output['status']);
        $this->assertSame('assistant', $output['role']);
        $this->assertSame([], $output['content'][0]['annotations']);
        $this->assertFalse($response['parallel_tool_calls']);
    }

    // ---------------------------------------------------------------
    // chatCompletionStreamEvents()
    // ---------------------------------------------------------------

    public function testStreamEventsReturnsCorrectEventCount(): void
    {
        $events = OpenAiCompat::chatCompletionStreamEvents([
            'id' => 'chatcmpl-stream1',
            'created' => 1710000000,
            'model' => 'gpt-5.4',
            'choices' => [
                ['message' => ['content' => 'streamed']],
            ],
        ]);

        $this->assertCount(3, $events);
    }

    public function testStreamEventsHasRoleDeltaEvent(): void
    {
        $events = OpenAiCompat::chatCompletionStreamEvents([
            'id' => 'chatcmpl-role1',
            'choices' => [
                ['message' => ['content' => 'test']],
            ],
        ]);

        $first = $events[0]['data'];
        $this->assertSame('chat.completion.chunk', $first['object']);
        $this->assertSame('assistant', $first['choices'][0]['delta']['role']);
        $this->assertSame('', $first['choices'][0]['delta']['content']);
        $this->assertNull($first['choices'][0]['finish_reason']);
    }

    public function testStreamEventsHasContentDeltaEvent(): void
    {
        $events = OpenAiCompat::chatCompletionStreamEvents([
            'id' => 'chatcmpl-content1',
            'choices' => [
                ['message' => ['content' => 'Hello world']],
            ],
        ]);

        $second = $events[1]['data'];
        $this->assertSame('Hello world', $second['choices'][0]['delta']['content']);
        $this->assertNull($second['choices'][0]['finish_reason']);
    }

    public function testStreamEventsHasFinishReasonEvent(): void
    {
        $events = OpenAiCompat::chatCompletionStreamEvents([
            'id' => 'chatcmpl-finish1',
            'choices' => [
                ['message' => ['content' => 'done']],
            ],
        ]);

        $last = $events[count($events) - 1]['data'];
        $this->assertSame('stop', $last['choices'][0]['finish_reason']);
        $this->assertEquals(new stdClass(), $last['choices'][0]['delta']);
    }

    public function testStreamEventsUsesCorrectModelName(): void
    {
        $events = OpenAiCompat::chatCompletionStreamEvents([
            'id' => 'chatcmpl-model1',
            'model' => 'gpt-5.4-mini',
            'choices' => [
                ['message' => ['content' => 'hi']],
            ],
        ]);

        foreach ($events as $event) {
            $this->assertSame('gpt-5.4-mini', $event['data']['model']);
        }
    }

    public function testStreamEventsPreservesIdAndCreated(): void
    {
        $events = OpenAiCompat::chatCompletionStreamEvents([
            'id' => 'chatcmpl-preserve1',
            'created' => 1710000000,
            'choices' => [
                ['message' => ['content' => 'x']],
            ],
        ]);

        foreach ($events as $event) {
            $this->assertSame('chatcmpl-preserve1', $event['data']['id']);
            $this->assertSame(1710000000, $event['data']['created']);
        }
    }

    public function testStreamEventsEmptyContentSkipsContentDelta(): void
    {
        $events = OpenAiCompat::chatCompletionStreamEvents([
            'id' => 'chatcmpl-empty1',
            'choices' => [
                ['message' => ['content' => '']],
            ],
        ]);

        // With empty content: role delta + finish event only (no content delta)
        $this->assertCount(2, $events);
        $this->assertSame('assistant', $events[0]['data']['choices'][0]['delta']['role']);
        $this->assertSame('stop', $events[1]['data']['choices'][0]['finish_reason']);
    }

    public function testStreamEventsWithNoChoicesProducesEmptyContent(): void
    {
        $events = OpenAiCompat::chatCompletionStreamEvents([
            'id' => 'chatcmpl-nochoice',
        ]);

        // No content extracted means no content delta: role delta + finish only
        $this->assertCount(2, $events);
    }
}
