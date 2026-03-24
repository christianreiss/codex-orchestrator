<?php

declare(strict_types=1);

use App\Exceptions\ValidationException;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Services\PricingService;
use App\Services\TokenUsageTracker;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class TokenUsageTrackerTest extends TestCase
{
    private TokenUsageTracker $tracker;
    private PricingService $pricingService;

    protected function setUp(): void
    {
        $tokenUsages = $this->getMockBuilder(TokenUsageRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $tokenUsageIngests = $this->getMockBuilder(TokenUsageIngestRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $this->pricingService = $this->getMockBuilder(PricingService::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['defaultModel', 'latestPricing', 'calculateCost'])
            ->getMock();
        $versions = $this->getMockBuilder(VersionRepository::class)
            ->disableOriginalConstructor()
            ->getMock();

        $this->tracker = new TokenUsageTracker(
            $tokenUsages,
            $tokenUsageIngests,
            $this->pricingService,
            $versions
        );
    }

    // -------------------------------------------------------------------------
    // sanitizeUsageLine
    // -------------------------------------------------------------------------

    public function testSanitizeUsageLineReturnsEmptyForEmptyString(): void
    {
        $this->assertSame('', $this->tracker->sanitizeUsageLine(''));
    }

    public function testSanitizeUsageLineTrimsWhitespace(): void
    {
        $this->assertSame('hello', $this->tracker->sanitizeUsageLine('  hello  '));
    }

    public function testSanitizeUsageLineStripsAnsiEscapeCodes(): void
    {
        $line = "\x1B[32mToken usage: 100\x1B[0m";
        $result = $this->tracker->sanitizeUsageLine($line);
        $this->assertStringNotContainsString("\x1B", $result);
        $this->assertStringContainsString('Token usage:', $result);
    }

    public function testSanitizeUsageLineStripsOscEscapeSequences(): void
    {
        $line = "before\x1B]0;title\x07Token usage: 50";
        $result = $this->tracker->sanitizeUsageLine($line);
        $this->assertStringNotContainsString("\x1B", $result);
    }

    public function testSanitizeUsageLineStripsControlChars(): void
    {
        $line = "Token\x01usage:\x02100";
        $result = $this->tracker->sanitizeUsageLine($line);
        $this->assertStringNotContainsString("\x01", $result);
        $this->assertStringNotContainsString("\x02", $result);
    }

    public function testSanitizeUsageLineExtractsTokenUsagePrefix(): void
    {
        $line = 'Some preamble text Token usage: 1500 tokens used';
        $result = $this->tracker->sanitizeUsageLine($line);
        $this->assertStringStartsWith('Token usage:', $result);
    }

    public function testSanitizeUsageLineCaseInsensitiveTokenUsageExtraction(): void
    {
        $line = 'prefix TOKEN USAGE: 200 output';
        $result = $this->tracker->sanitizeUsageLine($line);
        $this->assertStringStartsWith('TOKEN USAGE:', $result);
    }

    public function testSanitizeUsageLineCollapsesDuplicateBackslashes(): void
    {
        $line = 'Token usage: 100\\\\extra';
        $result = $this->tracker->sanitizeUsageLine($line);
        $this->assertStringNotContainsString('\\\\\\\\', $result);
    }

    public function testSanitizeUsageLineStripsNonPrintableAscii(): void
    {
        $line = "Token usage: \xC3\xA9 100";
        $result = $this->tracker->sanitizeUsageLine($line);
        // Non-ASCII bytes should be stripped by the printable-ASCII filter
        $this->assertMatchesRegularExpression('/^[\x20-\x7E]*$/', $result);
    }

    public function testSanitizeUsageLineTruncatesLongStrings(): void
    {
        $long = str_repeat('A', 1100);
        $result = $this->tracker->sanitizeUsageLine($long);
        $this->assertLessThanOrEqual(1003, strlen($result)); // 1000 + 3-byte UTF-8 ellipsis
        $this->assertStringEndsWith('…', $result);
    }

    public function testSanitizeUsageLineDoesNotTruncateExactLimit(): void
    {
        $line = str_repeat('X', 1000);
        $result = $this->tracker->sanitizeUsageLine($line);
        $this->assertSame(1000, strlen($result));
        $this->assertStringNotContainsString('…', $result);
    }

    public function testSanitizeUsageLineReturnsEmptyForWhitespaceOnly(): void
    {
        $this->assertSame('', $this->tracker->sanitizeUsageLine('   '));
    }

    // -------------------------------------------------------------------------
    // normalizeCommand
    // -------------------------------------------------------------------------

    public function testNormalizeCommandDefaultsToRetrieveForNull(): void
    {
        $this->assertSame('retrieve', $this->tracker->normalizeCommand(null));
    }

    public function testNormalizeCommandDefaultsToRetrieveForEmptyString(): void
    {
        $this->assertSame('retrieve', $this->tracker->normalizeCommand(''));
    }

    public function testNormalizeCommandDefaultsToRetrieveForWhitespace(): void
    {
        $this->assertSame('retrieve', $this->tracker->normalizeCommand('   '));
    }

    public function testNormalizeCommandDefaultsToRetrieveForArray(): void
    {
        $this->assertSame('retrieve', $this->tracker->normalizeCommand([]));
    }

    public function testNormalizeCommandAcceptsRetrieve(): void
    {
        $this->assertSame('retrieve', $this->tracker->normalizeCommand('retrieve'));
    }

    public function testNormalizeCommandAcceptsStore(): void
    {
        $this->assertSame('store', $this->tracker->normalizeCommand('store'));
    }

    public function testNormalizeCommandNormalizesToLowercase(): void
    {
        $this->assertSame('retrieve', $this->tracker->normalizeCommand('RETRIEVE'));
        $this->assertSame('store', $this->tracker->normalizeCommand('STORE'));
    }

    public function testNormalizeCommandTrimsWhitespace(): void
    {
        $this->assertSame('retrieve', $this->tracker->normalizeCommand('  retrieve  '));
        $this->assertSame('store', $this->tracker->normalizeCommand('  store  '));
    }

    public function testNormalizeCommandThrowsForInvalidValue(): void
    {
        $this->expectException(ValidationException::class);
        $this->tracker->normalizeCommand('invalid');
    }

    public function testNormalizeCommandThrowsForDelete(): void
    {
        $this->expectException(ValidationException::class);
        $this->tracker->normalizeCommand('delete');
    }

    // -------------------------------------------------------------------------
    // normalizeUsageEntry
    // -------------------------------------------------------------------------

    public function testNormalizeUsageEntryWithAllFields(): void
    {
        $entry = $this->tracker->normalizeUsageEntry([
            'line' => 'Token usage: 100',
            'total' => 100,
            'input' => 50,
            'output' => 50,
            'cached' => 10,
            'reasoning' => 5,
            'model' => 'gpt-5.4',
        ], 'usage');

        $this->assertSame('Token usage: 100', $entry['line']);
        $this->assertSame(100, $entry['total']);
        $this->assertSame(50, $entry['input']);
        $this->assertSame(50, $entry['output']);
        $this->assertSame(10, $entry['cached']);
        $this->assertSame(5, $entry['reasoning']);
        $this->assertSame('gpt-5.4', $entry['model']);
    }

    public function testNormalizeUsageEntryLineOnlyIsValid(): void
    {
        $entry = $this->tracker->normalizeUsageEntry(['line' => 'Token usage: 50'], 'usage');
        $this->assertSame('Token usage: 50', $entry['line']);
        $this->assertNull($entry['total']);
    }

    public function testNormalizeUsageEntryTotalOnlyIsValid(): void
    {
        $entry = $this->tracker->normalizeUsageEntry(['total' => 42], 'usage');
        $this->assertNull($entry['line']);
        $this->assertSame(42, $entry['total']);
    }

    public function testNormalizeUsageEntryNullFieldsReturnNull(): void
    {
        $entry = $this->tracker->normalizeUsageEntry(['total' => 10], 'usage');
        $this->assertNull($entry['input']);
        $this->assertNull($entry['output']);
        $this->assertNull($entry['cached']);
        $this->assertNull($entry['reasoning']);
        $this->assertNull($entry['model']);
    }

    public function testNormalizeUsageEntryEmptyThrows(): void
    {
        $this->expectException(ValidationException::class);
        $this->tracker->normalizeUsageEntry([], 'usage');
    }

    public function testNormalizeUsageEntryThrowsWhenAllFieldsEmpty(): void
    {
        $this->expectException(ValidationException::class);
        $this->tracker->normalizeUsageEntry([
            'line' => '',
            'total' => null,
            'input' => null,
            'output' => null,
        ], 'usage');
    }

    public function testNormalizeUsageEntryAcceptsStringIntegers(): void
    {
        $entry = $this->tracker->normalizeUsageEntry(['total' => '1,500', 'input' => '800'], 'usage');
        $this->assertSame(1500, $entry['total']);
        $this->assertSame(800, $entry['input']);
    }

    public function testNormalizeUsageEntryAcceptsStringWithUnderscores(): void
    {
        $entry = $this->tracker->normalizeUsageEntry(['total' => '1_000'], 'usage');
        $this->assertSame(1000, $entry['total']);
    }

    public function testNormalizeUsageEntryThrowsForNegativeTotal(): void
    {
        $this->expectException(ValidationException::class);
        $this->tracker->normalizeUsageEntry(['total' => -1], 'usage');
    }

    public function testNormalizeUsageEntryThrowsForInvalidStringTotal(): void
    {
        $this->expectException(ValidationException::class);
        $this->tracker->normalizeUsageEntry(['total' => 'abc'], 'usage');
    }

    public function testNormalizeUsageEntryTrimsModelName(): void
    {
        $entry = $this->tracker->normalizeUsageEntry(['total' => 10, 'model' => '  gpt-5.4  '], 'usage');
        $this->assertSame('gpt-5.4', $entry['model']);
    }

    public function testNormalizeUsageEntryIgnoresNonStringModel(): void
    {
        $entry = $this->tracker->normalizeUsageEntry(['total' => 10, 'model' => 123], 'usage');
        $this->assertNull($entry['model']);
    }

    public function testNormalizeUsageEntryEmptyModelBecomesNull(): void
    {
        $entry = $this->tracker->normalizeUsageEntry(['total' => 10, 'model' => ''], 'usage');
        $this->assertNull($entry['model']);
    }

    public function testNormalizeUsageEntryCachedAndReasoningAreOptional(): void
    {
        // null cached/reasoning should not throw even without the optional flag visible
        $entry = $this->tracker->normalizeUsageEntry(['total' => 10], 'usage');
        $this->assertNull($entry['cached']);
        $this->assertNull($entry['reasoning']);
    }

    // -------------------------------------------------------------------------
    // normalizeUsagePayloads
    // -------------------------------------------------------------------------

    public function testNormalizeUsagePayloadsSingleEntry(): void
    {
        $result = $this->tracker->normalizeUsagePayloads(['total' => 100, 'input' => 60, 'output' => 40]);
        $this->assertCount(1, $result);
        $this->assertSame(100, $result[0]['total']);
    }

    public function testNormalizeUsagePayloadsMultipleEntries(): void
    {
        $result = $this->tracker->normalizeUsagePayloads([
            'usages' => [
                ['total' => 100, 'input' => 60, 'output' => 40],
                ['total' => 200, 'input' => 120, 'output' => 80],
            ],
        ]);
        $this->assertCount(2, $result);
        $this->assertSame(100, $result[0]['total']);
        $this->assertSame(200, $result[1]['total']);
    }

    public function testNormalizeUsagePayloadsSkipsNonArrayEntries(): void
    {
        // Non-array entries inside usages[] are skipped; but we need at least one valid entry
        $result = $this->tracker->normalizeUsagePayloads([
            'usages' => [
                'not-an-array',
                ['total' => 50],
            ],
        ]);
        $this->assertCount(1, $result);
        $this->assertSame(50, $result[0]['total']);
    }

    public function testNormalizeUsagePayloadsThrowsWhenEmpty(): void
    {
        $this->expectException(ValidationException::class);
        $this->tracker->normalizeUsagePayloads(['usages' => []]);
    }

    public function testNormalizeUsagePayloadsThrowsWhenUsagesAllNonArray(): void
    {
        $this->expectException(ValidationException::class);
        $this->tracker->normalizeUsagePayloads(['usages' => ['string1', 'string2']]);
    }

    public function testNormalizeUsagePayloadsPathIncludesIndex(): void
    {
        try {
            $this->tracker->normalizeUsagePayloads(['usages' => [[]]]);
            $this->fail('Expected ValidationException');
        } catch (ValidationException $e) {
            $errors = $e->getErrors();
            $keys = array_keys($errors);
            $this->assertStringContainsString('usages.0', $keys[0]);
        }
    }

    public function testNormalizeUsagePayloadsLineOnlyUsages(): void
    {
        $result = $this->tracker->normalizeUsagePayloads(['line' => 'Token usage: 100 total']);
        $this->assertCount(1, $result);
        $this->assertStringContainsString('Token usage:', $result[0]['line']);
    }

    // -------------------------------------------------------------------------
    // normalizeUsageCost
    // -------------------------------------------------------------------------

    public function testNormalizeUsageCostReturnsNullWhenNoBillableFields(): void
    {
        $usage = ['total' => 100, 'line' => 'Token usage: 100'];
        $result = $this->tracker->normalizeUsageCost($usage, []);
        $this->assertNull($result);
    }

    public function testNormalizeUsageCostCalculatesWhenInputPresent(): void
    {
        $this->pricingService->method('calculateCost')->willReturn(0.015);
        $usage = ['input' => 500, 'output' => null, 'cached' => null];
        $pricing = ['input_price_per_1k' => 0.01, 'output_price_per_1k' => 0.03, 'cached_price_per_1k' => 0.005];
        $result = $this->tracker->normalizeUsageCost($usage, $pricing);
        $this->assertSame(0.015, $result);
    }

    public function testNormalizeUsageCostCalculatesWhenOutputPresent(): void
    {
        $this->pricingService->method('calculateCost')->willReturn(0.030);
        $usage = ['input' => null, 'output' => 1000, 'cached' => null];
        $pricing = ['input_price_per_1k' => 0.01, 'output_price_per_1k' => 0.03, 'cached_price_per_1k' => 0.005];
        $result = $this->tracker->normalizeUsageCost($usage, $pricing);
        $this->assertSame(0.03, $result);
    }

    public function testNormalizeUsageCostCalculatesWhenCachedPresent(): void
    {
        $this->pricingService->method('calculateCost')->willReturn(0.001);
        $usage = ['input' => null, 'output' => null, 'cached' => 200];
        $pricing = ['input_price_per_1k' => 0.01, 'output_price_per_1k' => 0.03, 'cached_price_per_1k' => 0.005];
        $result = $this->tracker->normalizeUsageCost($usage, $pricing);
        $this->assertSame(0.001, $result);
    }

    public function testNormalizeUsageCostRoundsToSixDecimals(): void
    {
        $this->pricingService->method('calculateCost')->willReturn(0.1234567890);
        $usage = ['input' => 100, 'output' => 0, 'cached' => 0];
        $result = $this->tracker->normalizeUsageCost($usage, []);
        $this->assertSame(round(0.1234567890, 6), $result);
    }

    public function testNormalizeUsageCostReturnsNullForNanResult(): void
    {
        $this->pricingService->method('calculateCost')->willReturn(NAN);
        $usage = ['input' => 100, 'output' => 0, 'cached' => 0];
        $result = $this->tracker->normalizeUsageCost($usage, []);
        $this->assertNull($result);
    }

    public function testNormalizeUsageCostReturnsNullForNegativeResult(): void
    {
        $this->pricingService->method('calculateCost')->willReturn(-0.5);
        $usage = ['input' => 100, 'output' => 0, 'cached' => 0];
        $result = $this->tracker->normalizeUsageCost($usage, []);
        $this->assertNull($result);
    }

    public function testNormalizeUsageCostReturnsNullForInfiniteResult(): void
    {
        $this->pricingService->method('calculateCost')->willReturn(INF);
        $usage = ['input' => 100, 'output' => 0, 'cached' => 0];
        $result = $this->tracker->normalizeUsageCost($usage, []);
        $this->assertNull($result);
    }

    public function testNormalizeUsageCostZeroIsValid(): void
    {
        $this->pricingService->method('calculateCost')->willReturn(0.0);
        $usage = ['input' => 0, 'output' => 0, 'cached' => 0];
        $result = $this->tracker->normalizeUsageCost($usage, []);
        $this->assertSame(0.0, $result);
    }
}
