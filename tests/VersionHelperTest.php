<?php

declare(strict_types=1);

use App\Http\VersionHelper;
use App\Repositories\VersionRepository;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

/**
 * Unit tests for VersionHelper.
 *
 * The public surface under test:
 *   - normalizeVersionValue()          pure helper, no I/O
 *   - normalizeBoolean()               pure helper, no I/O
 *   - normalizeReverseDnsModeInput()   pure helper, no I/O
 *   - formatReverseDnsModeOutput()     pure helper, no I/O
 *   - modelUsesSparkQuotaLane()        pure helper, no I/O
 *   - resolveActiveQuotaLaneForHost()  reads VersionRepository (mocked)
 *   - extractClientVersion()           payload-first branch only
 *   - extractWrapperVersion()          payload-first branch only
 *
 * Methods that require VersionRepository DB access (quotaLimitPercent,
 * quotaWeekPartition, inactivityWindowDays) delegate to AuthService static
 * normalization helpers; their integration is exercised in broader auth
 * bootstrap tests. extractClientVersion/extractWrapperVersion query-param
 * fallback paths rely on $_GET superglobals and are not covered here.
 */
final class VersionHelperTest extends TestCase
{
    // -------------------------------------------------------------------------
    // normalizeVersionValue
    // -------------------------------------------------------------------------

    public function testNormalizeVersionValueReturnsNullForNull(): void
    {
        $this->assertNull(VersionHelper::normalizeVersionValue(null));
    }

    public function testNormalizeVersionValueReturnsNullForBool(): void
    {
        $this->assertNull(VersionHelper::normalizeVersionValue(true));
        $this->assertNull(VersionHelper::normalizeVersionValue(false));
    }

    public function testNormalizeVersionValueReturnsNullForInt(): void
    {
        $this->assertNull(VersionHelper::normalizeVersionValue(42));
    }

    public function testNormalizeVersionValueReturnsNullForArray(): void
    {
        $this->assertNull(VersionHelper::normalizeVersionValue([]));
    }

    public function testNormalizeVersionValueReturnsNullForEmptyString(): void
    {
        $this->assertNull(VersionHelper::normalizeVersionValue(''));
    }

    public function testNormalizeVersionValueReturnsNullForWhitespaceOnlyString(): void
    {
        $this->assertNull(VersionHelper::normalizeVersionValue('   '));
    }

    public function testNormalizeVersionValueReturnsTrimmedString(): void
    {
        $this->assertSame('2026.03.24', VersionHelper::normalizeVersionValue('  2026.03.24  '));
    }

    public function testNormalizeVersionValueReturnsPlainString(): void
    {
        $this->assertSame('1.2.3', VersionHelper::normalizeVersionValue('1.2.3'));
    }

    public function testNormalizeVersionValueReturnsFalsyString(): void
    {
        // The string '0' is falsy but is a valid non-empty version value
        $this->assertSame('0', VersionHelper::normalizeVersionValue('0'));
    }

    // -------------------------------------------------------------------------
    // normalizeBoolean
    // -------------------------------------------------------------------------

    public function testNormalizeBooleanReturnsTrueForBoolTrue(): void
    {
        $this->assertTrue(VersionHelper::normalizeBoolean(true));
    }

    public function testNormalizeBooleanReturnsFalseForBoolFalse(): void
    {
        $this->assertFalse(VersionHelper::normalizeBoolean(false));
    }

    public function testNormalizeBooleanReturnsTrueForInt1(): void
    {
        $this->assertTrue(VersionHelper::normalizeBoolean(1));
    }

    public function testNormalizeBooleanReturnsFalseForInt0(): void
    {
        $this->assertFalse(VersionHelper::normalizeBoolean(0));
    }

    public function testNormalizeBooleanReturnsNullForOtherInt(): void
    {
        $this->assertNull(VersionHelper::normalizeBoolean(2));
        $this->assertNull(VersionHelper::normalizeBoolean(-1));
    }

    public function testNormalizeBooleanReturnsTrueForStringOne(): void
    {
        $this->assertTrue(VersionHelper::normalizeBoolean('1'));
    }

    public function testNormalizeBooleanReturnsFalseForStringZero(): void
    {
        $this->assertFalse(VersionHelper::normalizeBoolean('0'));
    }

    public function testNormalizeBooleanReturnsTrueForStringTrue(): void
    {
        $this->assertTrue(VersionHelper::normalizeBoolean('true'));
        $this->assertTrue(VersionHelper::normalizeBoolean('TRUE'));
        $this->assertTrue(VersionHelper::normalizeBoolean('True'));
    }

    public function testNormalizeBooleanReturnsFalseForStringFalse(): void
    {
        $this->assertFalse(VersionHelper::normalizeBoolean('false'));
        $this->assertFalse(VersionHelper::normalizeBoolean('FALSE'));
    }

    public function testNormalizeBooleanReturnsTrueForYes(): void
    {
        $this->assertTrue(VersionHelper::normalizeBoolean('yes'));
        $this->assertTrue(VersionHelper::normalizeBoolean('YES'));
    }

    public function testNormalizeBooleanReturnsFalseForNo(): void
    {
        $this->assertFalse(VersionHelper::normalizeBoolean('no'));
        $this->assertFalse(VersionHelper::normalizeBoolean('NO'));
    }

    public function testNormalizeBooleanReturnsTrueForOn(): void
    {
        $this->assertTrue(VersionHelper::normalizeBoolean('on'));
        $this->assertTrue(VersionHelper::normalizeBoolean('ON'));
    }

    public function testNormalizeBooleanReturnsFalseForOff(): void
    {
        $this->assertFalse(VersionHelper::normalizeBoolean('off'));
        $this->assertFalse(VersionHelper::normalizeBoolean('OFF'));
    }

    public function testNormalizeBooleanTrimsWhitespaceBeforeMatching(): void
    {
        $this->assertTrue(VersionHelper::normalizeBoolean('  yes  '));
        $this->assertFalse(VersionHelper::normalizeBoolean('  no  '));
    }

    public function testNormalizeBooleanReturnsNullForUnrecognizedString(): void
    {
        $this->assertNull(VersionHelper::normalizeBoolean('maybe'));
        $this->assertNull(VersionHelper::normalizeBoolean('enabled'));
        $this->assertNull(VersionHelper::normalizeBoolean(''));
    }

    public function testNormalizeBooleanReturnsNullForNull(): void
    {
        $this->assertNull(VersionHelper::normalizeBoolean(null));
    }

    public function testNormalizeBooleanReturnsNullForArray(): void
    {
        $this->assertNull(VersionHelper::normalizeBoolean([]));
    }

    public function testNormalizeBooleanReturnsNullForFloat(): void
    {
        $this->assertNull(VersionHelper::normalizeBoolean(1.0));
    }

    // -------------------------------------------------------------------------
    // normalizeReverseDnsModeInput
    // -------------------------------------------------------------------------

    public function testNormalizeReverseDnsModeInputReturnsGlobalForNull(): void
    {
        $this->assertSame('global', VersionHelper::normalizeReverseDnsModeInput(null));
    }

    public function testNormalizeReverseDnsModeInputReturnsTrueForBoolTrue(): void
    {
        $this->assertSame('enabled', VersionHelper::normalizeReverseDnsModeInput(true));
    }

    public function testNormalizeReverseDnsModeInputReturnsFalseForBoolFalse(): void
    {
        $this->assertSame('disabled', VersionHelper::normalizeReverseDnsModeInput(false));
    }

    public function testNormalizeReverseDnsModeInputReturnsEnabledForNonZeroInt(): void
    {
        $this->assertSame('enabled', VersionHelper::normalizeReverseDnsModeInput(1));
        $this->assertSame('enabled', VersionHelper::normalizeReverseDnsModeInput(-1));
        $this->assertSame('enabled', VersionHelper::normalizeReverseDnsModeInput(99));
    }

    public function testNormalizeReverseDnsModeInputReturnsDisabledForZeroInt(): void
    {
        $this->assertSame('disabled', VersionHelper::normalizeReverseDnsModeInput(0));
    }

    public function testNormalizeReverseDnsModeInputReturnsGlobalForEmptyString(): void
    {
        $this->assertSame('global', VersionHelper::normalizeReverseDnsModeInput(''));
        $this->assertSame('global', VersionHelper::normalizeReverseDnsModeInput('   '));
    }

    public function testNormalizeReverseDnsModeInputReturnsGlobalForGlobal(): void
    {
        $this->assertSame('global', VersionHelper::normalizeReverseDnsModeInput('global'));
        $this->assertSame('global', VersionHelper::normalizeReverseDnsModeInput('GLOBAL'));
    }

    public function testNormalizeReverseDnsModeInputReturnsGlobalForDefault(): void
    {
        $this->assertSame('global', VersionHelper::normalizeReverseDnsModeInput('default'));
        $this->assertSame('global', VersionHelper::normalizeReverseDnsModeInput('DEFAULT'));
    }

    public function testNormalizeReverseDnsModeInputReturnsEnabledForTruthyStrings(): void
    {
        foreach (['1', 'true', 'yes', 'on', 'enabled', 'enable'] as $v) {
            $this->assertSame('enabled', VersionHelper::normalizeReverseDnsModeInput($v), "Expected 'enabled' for '$v'");
            $this->assertSame('enabled', VersionHelper::normalizeReverseDnsModeInput(strtoupper($v)), "Expected 'enabled' for '" . strtoupper($v) . "'");
        }
    }

    public function testNormalizeReverseDnsModeInputReturnsDisabledForFalsyStrings(): void
    {
        foreach (['0', 'false', 'no', 'off', 'disabled', 'disable'] as $v) {
            $this->assertSame('disabled', VersionHelper::normalizeReverseDnsModeInput($v), "Expected 'disabled' for '$v'");
            $this->assertSame('disabled', VersionHelper::normalizeReverseDnsModeInput(strtoupper($v)), "Expected 'disabled' for '" . strtoupper($v) . "'");
        }
    }

    public function testNormalizeReverseDnsModeInputReturnsNullForUnrecognizedString(): void
    {
        $this->assertNull(VersionHelper::normalizeReverseDnsModeInput('maybe'));
        $this->assertNull(VersionHelper::normalizeReverseDnsModeInput('2'));
        $this->assertNull(VersionHelper::normalizeReverseDnsModeInput('required'));
    }

    public function testNormalizeReverseDnsModeInputReturnsNullForArray(): void
    {
        $this->assertNull(VersionHelper::normalizeReverseDnsModeInput([]));
    }

    // -------------------------------------------------------------------------
    // formatReverseDnsModeOutput
    // -------------------------------------------------------------------------

    public function testFormatReverseDnsModeOutputReturnsGlobalForNull(): void
    {
        $this->assertSame('global', VersionHelper::formatReverseDnsModeOutput(null));
    }

    public function testFormatReverseDnsModeOutputReturnsEnabledForBoolTrue(): void
    {
        $this->assertSame('enabled', VersionHelper::formatReverseDnsModeOutput(true));
    }

    public function testFormatReverseDnsModeOutputReturnsDisabledForBoolFalse(): void
    {
        $this->assertSame('disabled', VersionHelper::formatReverseDnsModeOutput(false));
    }

    public function testFormatReverseDnsModeOutputReturnsEnabledForNonZeroInt(): void
    {
        $this->assertSame('enabled', VersionHelper::formatReverseDnsModeOutput(1));
        $this->assertSame('enabled', VersionHelper::formatReverseDnsModeOutput(-5));
    }

    public function testFormatReverseDnsModeOutputReturnsDisabledForZeroInt(): void
    {
        $this->assertSame('disabled', VersionHelper::formatReverseDnsModeOutput(0));
    }

    public function testFormatReverseDnsModeOutputPassesThroughCanonicalStrings(): void
    {
        $this->assertSame('enabled', VersionHelper::formatReverseDnsModeOutput('enabled'));
        $this->assertSame('disabled', VersionHelper::formatReverseDnsModeOutput('disabled'));
        $this->assertSame('global', VersionHelper::formatReverseDnsModeOutput('global'));
    }

    public function testFormatReverseDnsModeOutputNormalizesCanonicalStringCase(): void
    {
        $this->assertSame('enabled', VersionHelper::formatReverseDnsModeOutput('ENABLED'));
        $this->assertSame('disabled', VersionHelper::formatReverseDnsModeOutput('Disabled'));
        $this->assertSame('global', VersionHelper::formatReverseDnsModeOutput('Global'));
    }

    public function testFormatReverseDnsModeOutputConvertsTruthyStrings(): void
    {
        foreach (['1', 'true', 'yes', 'on'] as $v) {
            $this->assertSame('enabled', VersionHelper::formatReverseDnsModeOutput($v), "Expected 'enabled' for '$v'");
        }
    }

    public function testFormatReverseDnsModeOutputConvertsFalsyStrings(): void
    {
        foreach (['0', 'false', 'no', 'off'] as $v) {
            $this->assertSame('disabled', VersionHelper::formatReverseDnsModeOutput($v), "Expected 'disabled' for '$v'");
        }
    }

    public function testFormatReverseDnsModeOutputFallsBackToGlobalForUnrecognizedString(): void
    {
        $this->assertSame('global', VersionHelper::formatReverseDnsModeOutput('maybe'));
        $this->assertSame('global', VersionHelper::formatReverseDnsModeOutput(''));
        $this->assertSame('global', VersionHelper::formatReverseDnsModeOutput('required'));
    }

    public function testFormatReverseDnsModeOutputFallsBackToGlobalForArray(): void
    {
        $this->assertSame('global', VersionHelper::formatReverseDnsModeOutput([]));
    }

    // -------------------------------------------------------------------------
    // modelUsesSparkQuotaLane
    // -------------------------------------------------------------------------

    public function testModelUsesSparkQuotaLaneReturnsNullForNull(): void
    {
        $this->assertNull(VersionHelper::modelUsesSparkQuotaLane(null));
    }

    public function testModelUsesSparkQuotaLaneReturnsNullForEmptyString(): void
    {
        $this->assertNull(VersionHelper::modelUsesSparkQuotaLane(''));
    }

    public function testModelUsesSparkQuotaLaneReturnsNullForWhitespaceOnlyString(): void
    {
        $this->assertNull(VersionHelper::modelUsesSparkQuotaLane('   '));
    }

    public function testModelUsesSparkQuotaLaneReturnsTrueForSparkModel(): void
    {
        $this->assertTrue(VersionHelper::modelUsesSparkQuotaLane('spark'));
        $this->assertTrue(VersionHelper::modelUsesSparkQuotaLane('spark-4'));
        $this->assertTrue(VersionHelper::modelUsesSparkQuotaLane('codex-spark'));
        $this->assertTrue(VersionHelper::modelUsesSparkQuotaLane('codex-spark-latest'));
    }

    public function testModelUsesSparkQuotaLaneIsCaseInsensitive(): void
    {
        $this->assertTrue(VersionHelper::modelUsesSparkQuotaLane('SPARK'));
        $this->assertTrue(VersionHelper::modelUsesSparkQuotaLane('Spark-1'));
    }

    public function testModelUsesSparkQuotaLaneReturnsFalseForNonSparkModel(): void
    {
        $this->assertFalse(VersionHelper::modelUsesSparkQuotaLane('normal'));
        $this->assertFalse(VersionHelper::modelUsesSparkQuotaLane('gpt-4'));
        $this->assertFalse(VersionHelper::modelUsesSparkQuotaLane('codex-mini'));
        $this->assertFalse(VersionHelper::modelUsesSparkQuotaLane('o3'));
    }

    // -------------------------------------------------------------------------
    // resolveActiveQuotaLaneForHost
    // -------------------------------------------------------------------------

    private function makeVersionRepo(?string $cdxModel = null): VersionRepository
    {
        $repo = $this->createMock(VersionRepository::class);
        $repo->method('get')
            ->with('cdx_model')
            ->willReturn($cdxModel);
        return $repo;
    }

    public function testResolveActiveQuotaLaneUsesHostLanePreference(): void
    {
        $host = ['lane_preference' => 'spark', 'model_override' => null];
        $result = VersionHelper::resolveActiveQuotaLaneForHost($host, $this->makeVersionRepo());

        $this->assertSame('spark', $result);
    }

    public function testResolveActiveQuotaLaneUsesHostLanePreferenceNormal(): void
    {
        $host = ['lane_preference' => 'normal', 'model_override' => 'spark-model'];
        // lane_preference wins over model_override
        $result = VersionHelper::resolveActiveQuotaLaneForHost($host, $this->makeVersionRepo('spark-global'));

        $this->assertSame('normal', $result);
    }

    public function testResolveActiveQuotaLaneFallsToModelOverrideWhenNoLanePreference(): void
    {
        $host = ['lane_preference' => null, 'model_override' => 'codex-spark'];
        $result = VersionHelper::resolveActiveQuotaLaneForHost($host, $this->makeVersionRepo());

        $this->assertSame('spark', $result);
    }

    public function testResolveActiveQuotaLaneModelOverrideNormalGivesNormal(): void
    {
        $host = ['lane_preference' => null, 'model_override' => 'gpt-4'];
        $result = VersionHelper::resolveActiveQuotaLaneForHost($host, $this->makeVersionRepo('spark-global'));
        // model_override is non-spark, so 'normal'; global model is irrelevant
        $this->assertSame('normal', $result);
    }

    public function testResolveActiveQuotaLaneFallsToGlobalModelWhenNoHostPreferences(): void
    {
        $host = ['lane_preference' => null, 'model_override' => null];
        $result = VersionHelper::resolveActiveQuotaLaneForHost($host, $this->makeVersionRepo('spark-global'));

        $this->assertSame('spark', $result);
    }

    public function testResolveActiveQuotaLaneGlobalModelNormalGivesNormal(): void
    {
        $host = ['lane_preference' => null, 'model_override' => null];
        $result = VersionHelper::resolveActiveQuotaLaneForHost($host, $this->makeVersionRepo('codex-mini'));

        $this->assertSame('normal', $result);
    }

    public function testResolveActiveQuotaLaneUsesExplicitFallback(): void
    {
        $host = ['lane_preference' => null, 'model_override' => null];
        $result = VersionHelper::resolveActiveQuotaLaneForHost($host, $this->makeVersionRepo(null), 'spark');

        $this->assertSame('spark', $result);
    }

    public function testResolveActiveQuotaLaneDefaultsToNormalWithNoSignals(): void
    {
        $host = ['lane_preference' => null, 'model_override' => null];
        $result = VersionHelper::resolveActiveQuotaLaneForHost($host, $this->makeVersionRepo(null));

        $this->assertSame('normal', $result);
    }

    public function testResolveActiveQuotaLaneHandlesMissingHostKeys(): void
    {
        // Empty host array — all keys absent; should fall through to 'normal'
        $result = VersionHelper::resolveActiveQuotaLaneForHost([], $this->makeVersionRepo(null));

        $this->assertSame('normal', $result);
    }

    // -------------------------------------------------------------------------
    // extractClientVersion (payload-first branch)
    // -------------------------------------------------------------------------

    public function testExtractClientVersionReturnsFromPayload(): void
    {
        $result = VersionHelper::extractClientVersion(['client_version' => '2026.03.24']);

        $this->assertSame('2026.03.24', $result);
    }

    public function testExtractClientVersionTrimsPayloadValue(): void
    {
        $result = VersionHelper::extractClientVersion(['client_version' => '  1.2.3  ']);

        $this->assertSame('1.2.3', $result);
    }

    public function testExtractClientVersionSkipsEmptyPayloadValue(): void
    {
        // Empty string in payload → falls through; no query param set → null
        $result = VersionHelper::extractClientVersion(['client_version' => '']);

        // No $_GET fallback in unit-test context — result is null or absent
        // The assertion simply verifies the empty-string payload is not returned as-is
        $this->assertNotSame('', $result);
    }

    public function testExtractClientVersionReturnsNullForNonArrayPayload(): void
    {
        // Non-array payload → falls to query-param path (absent in tests) → null
        $result = VersionHelper::extractClientVersion(null);

        $this->assertNull($result);
    }

    // -------------------------------------------------------------------------
    // extractWrapperVersion (payload-first branch)
    // -------------------------------------------------------------------------

    public function testExtractWrapperVersionReturnsFromPayload(): void
    {
        $result = VersionHelper::extractWrapperVersion(['wrapper_version' => '2026.03.24-01']);

        $this->assertSame('2026.03.24-01', $result);
    }

    public function testExtractWrapperVersionTrimsPayloadValue(): void
    {
        $result = VersionHelper::extractWrapperVersion(['wrapper_version' => '  v1.0  ']);

        $this->assertSame('v1.0', $result);
    }

    public function testExtractWrapperVersionSkipsEmptyPayloadValue(): void
    {
        $result = VersionHelper::extractWrapperVersion(['wrapper_version' => '   ']);

        $this->assertNotSame('', $result);
        $this->assertNotSame('   ', $result);
    }

    public function testExtractWrapperVersionReturnsNullForNonArrayPayload(): void
    {
        $result = VersionHelper::extractWrapperVersion(null);

        $this->assertNull($result);
    }
}
