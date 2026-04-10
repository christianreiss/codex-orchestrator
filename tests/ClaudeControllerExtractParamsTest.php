<?php

declare(strict_types=1);

use App\Http\Controllers\ClaudeApiController;
use PHPUnit\Framework\TestCase;

final class ClaudeControllerExtractParamsTest extends TestCase
{
    /**
     * Invoke the private static extractParams method via reflection.
     */
    private static function extractParams(array $payload): array
    {
        $method = new ReflectionMethod(ClaudeApiController::class, 'extractParams');

        return $method->invoke(null, $payload);
    }

    public function testExtractsBasicParams(): void
    {
        $result = self::extractParams([
            'max_tokens' => 1024,
            'temperature' => 0.7,
            'top_p' => 0.9,
            'top_k' => 40,
            'stop_sequences' => ["\n"],
            'system' => 'You are helpful.',
        ]);

        $this->assertSame(1024, $result['max_tokens']);
        $this->assertSame(0.7, $result['temperature']);
        $this->assertSame(0.9, $result['top_p']);
        $this->assertSame(40, $result['top_k']);
        $this->assertSame(["\n"], $result['stop_sequences']);
        $this->assertSame('You are helpful.', $result['system']);
    }

    public function testMapsStopStringToStopSequences(): void
    {
        $result = self::extractParams([
            'stop' => "\n",
        ]);

        $this->assertSame(["\n"], $result['stop_sequences']);
        $this->assertArrayNotHasKey('stop', $result);
    }

    public function testMapsStopArrayToStopSequences(): void
    {
        $result = self::extractParams([
            'stop' => ["\n", 'END'],
        ]);

        $this->assertSame(["\n", 'END'], $result['stop_sequences']);
        $this->assertArrayNotHasKey('stop', $result);
    }

    public function testStopSequencesTakesPriorityOverStop(): void
    {
        $result = self::extractParams([
            'stop' => 'ignored',
            'stop_sequences' => ['kept'],
        ]);

        $this->assertSame(['kept'], $result['stop_sequences']);
    }

    public function testEmptyPayloadReturnsEmptyArray(): void
    {
        $result = self::extractParams([]);

        $this->assertSame([], $result);
    }

    public function testUnknownParamsAreIgnored(): void
    {
        $result = self::extractParams([
            'max_tokens' => 256,
            'unknown_param' => 'value',
            'frequency_penalty' => 0.5,
            'presence_penalty' => 0.3,
        ]);

        $this->assertSame(['max_tokens' => 256], $result);
        $this->assertArrayNotHasKey('unknown_param', $result);
        $this->assertArrayNotHasKey('frequency_penalty', $result);
        $this->assertArrayNotHasKey('presence_penalty', $result);
    }

    public function testExtractsSubsetOfParams(): void
    {
        $result = self::extractParams([
            'temperature' => 0.5,
            'top_k' => 10,
        ]);

        $this->assertSame(['temperature' => 0.5, 'top_k' => 10], $result);
        $this->assertArrayNotHasKey('max_tokens', $result);
        $this->assertArrayNotHasKey('top_p', $result);
        $this->assertArrayNotHasKey('stop_sequences', $result);
        $this->assertArrayNotHasKey('system', $result);
    }
}
