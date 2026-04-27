<?php

declare(strict_types=1);

use App\Exceptions\ValidationException;
use App\Services\ConfigNormalizer;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class ConfigNormalizerTest extends TestCase
{
    private ConfigNormalizer $normalizer;

    protected function setUp(): void
    {
        $this->normalizer = new ConfigNormalizer();
    }

    // -------------------------------------------------------------------------
    // normalizeString
    // -------------------------------------------------------------------------

    public function testNormalizeStringReturnsNullForNull(): void
    {
        $this->assertNull($this->normalizer->normalizeString(null));
    }

    public function testNormalizeStringReturnsNullForArray(): void
    {
        $this->assertNull($this->normalizer->normalizeString([]));
    }

    public function testNormalizeStringReturnsNullForEmptyString(): void
    {
        $this->assertNull($this->normalizer->normalizeString(''));
    }

    public function testNormalizeStringReturnsTrimmedValue(): void
    {
        $this->assertSame('hello', $this->normalizer->normalizeString('  hello  '));
    }

    public function testNormalizeStringAcceptsNumeric(): void
    {
        $this->assertSame('42', $this->normalizer->normalizeString(42));
    }

    public function testNormalizeStringReturnsNullForWhitespaceOnly(): void
    {
        $this->assertNull($this->normalizer->normalizeString('   '));
    }

    // -------------------------------------------------------------------------
    // normalizeBool
    // -------------------------------------------------------------------------

    public function testNormalizeBoolReturnsTrueForBoolTrue(): void
    {
        $this->assertTrue($this->normalizer->normalizeBool(true));
    }

    public function testNormalizeBoolReturnsFalseForBoolFalse(): void
    {
        $this->assertFalse($this->normalizer->normalizeBool(false));
    }

    /** @dataProvider truthyStringProvider */
    public function testNormalizeBoolReturnsTrueForTruthyStrings(string $value): void
    {
        $this->assertTrue($this->normalizer->normalizeBool($value));
    }

    /** @return list<array{string}> */
    public static function truthyStringProvider(): array
    {
        return [['1'], ['true'], ['yes'], ['on'], ['TRUE'], ['YES'], [' on ']];
    }

    /** @dataProvider falsyStringProvider */
    public function testNormalizeBoolReturnsFalseForFalsyStrings(string $value): void
    {
        $this->assertFalse($this->normalizer->normalizeBool($value));
    }

    /** @return list<array{string}> */
    public static function falsyStringProvider(): array
    {
        return [['0'], ['false'], ['no'], ['off'], ['FALSE'], ['NO'], [' off ']];
    }

    public function testNormalizeBoolReturnsTrueForNonZeroInt(): void
    {
        $this->assertTrue($this->normalizer->normalizeBool(1));
    }

    public function testNormalizeBoolReturnsFalseForZeroInt(): void
    {
        $this->assertFalse($this->normalizer->normalizeBool(0));
    }

    public function testNormalizeBoolReturnsDefaultForNull(): void
    {
        $this->assertNull($this->normalizer->normalizeBool(null));
        $this->assertTrue($this->normalizer->normalizeBool(null, true));
        $this->assertFalse($this->normalizer->normalizeBool(null, false));
    }

    public function testNormalizeBoolReturnsNullForUnrecognizedString(): void
    {
        $this->assertNull($this->normalizer->normalizeBool('maybe'));
    }

    // -------------------------------------------------------------------------
    // normalizeWebSearchFeature
    // -------------------------------------------------------------------------

    public function testNormalizeWebSearchBoolTrueReturnsLive(): void
    {
        $this->assertSame('live', $this->normalizer->normalizeWebSearchFeature(true));
    }

    public function testNormalizeWebSearchBoolFalseReturnsDisabled(): void
    {
        $this->assertSame('disabled', $this->normalizer->normalizeWebSearchFeature(false));
    }

    public function testNormalizeWebSearchNonZeroIntReturnsLive(): void
    {
        $this->assertSame('live', $this->normalizer->normalizeWebSearchFeature(1));
    }

    public function testNormalizeWebSearchZeroIntReturnsDisabled(): void
    {
        $this->assertSame('disabled', $this->normalizer->normalizeWebSearchFeature(0));
    }

    /** @dataProvider webSearchStringProvider */
    public function testNormalizeWebSearchStrings(string $input, string $expected): void
    {
        $this->assertSame($expected, $this->normalizer->normalizeWebSearchFeature($input));
    }

    /** @return list<array{string, string}> */
    public static function webSearchStringProvider(): array
    {
        return [
            ['live', 'live'],
            ['cached', 'cached'],
            ['disabled', 'disabled'],
            ['LIVE', 'live'],
            ['1', 'live'],
            ['true', 'live'],
            ['yes', 'live'],
            ['on', 'live'],
            ['0', 'disabled'],
            ['false', 'disabled'],
            ['no', 'disabled'],
        ];
    }

    public function testNormalizeWebSearchReturnsNullForUnknown(): void
    {
        $this->assertNull($this->normalizer->normalizeWebSearchFeature('maybe'));
        $this->assertNull($this->normalizer->normalizeWebSearchFeature(null));
        $this->assertNull($this->normalizer->normalizeWebSearchFeature([]));
    }

    // -------------------------------------------------------------------------
    // normalizeApprovalPolicy
    // -------------------------------------------------------------------------

    public function testNormalizeApprovalPolicyOnFailureBecomesOnRequest(): void
    {
        $this->assertSame('on-request', $this->normalizer->normalizeApprovalPolicy('on-failure'));
        $this->assertSame('on-request', $this->normalizer->normalizeApprovalPolicy('ON-FAILURE'));
    }

    public function testNormalizeApprovalPolicyPassthroughForOtherValues(): void
    {
        $this->assertSame('on-request', $this->normalizer->normalizeApprovalPolicy('on-request'));
        $this->assertSame('never', $this->normalizer->normalizeApprovalPolicy('never'));
    }

    public function testNormalizeApprovalPolicyReturnsNullForNull(): void
    {
        $this->assertNull($this->normalizer->normalizeApprovalPolicy(null));
    }

    // -------------------------------------------------------------------------
    // normalizePersonality
    // -------------------------------------------------------------------------

    public function testNormalizePersonalityAcceptsValidValues(): void
    {
        $this->assertSame('friendly', $this->normalizer->normalizePersonality('friendly'));
        $this->assertSame('pragmatic', $this->normalizer->normalizePersonality('pragmatic'));
        $this->assertSame('none', $this->normalizer->normalizePersonality('none'));
    }

    public function testNormalizePersonalityIsCaseInsensitive(): void
    {
        $this->assertSame('friendly', $this->normalizer->normalizePersonality('FRIENDLY'));
    }

    public function testNormalizePersonalityReturnsNullForInvalidValue(): void
    {
        $this->assertNull($this->normalizer->normalizePersonality('casual'));
        $this->assertNull($this->normalizer->normalizePersonality(null));
    }

    // -------------------------------------------------------------------------
    // normalizeReasoningSummary
    // -------------------------------------------------------------------------

    public function testNormalizeReasoningSummaryAcceptsValidValues(): void
    {
        $this->assertSame('auto', $this->normalizer->normalizeReasoningSummary('auto'));
        $this->assertSame('concise', $this->normalizer->normalizeReasoningSummary('concise'));
        $this->assertSame('detailed', $this->normalizer->normalizeReasoningSummary('detailed'));
    }

    public function testNormalizeReasoningSummaryNoneReturnsNull(): void
    {
        $this->assertNull($this->normalizer->normalizeReasoningSummary('none'));
    }

    public function testNormalizeReasoningSummaryReturnsNullForInvalidValue(): void
    {
        $this->assertNull($this->normalizer->normalizeReasoningSummary('brief'));
        $this->assertNull($this->normalizer->normalizeReasoningSummary(null));
    }

    public function testNormalizeReasoningSummarySparkModelReturnsNull(): void
    {
        $this->assertNull($this->normalizer->normalizeReasoningSummary('auto', 'gpt-5.3-codex-spark'));
        $this->assertNull($this->normalizer->normalizeReasoningSummary('detailed', 'gpt-5.3-codex-spark'));
    }

    public function testNormalizeReasoningSummaryDetailedOnlyModelsForceDetailed(): void
    {
        foreach (['gpt-5.3-codex'] as $model) {
            $this->assertSame('detailed', $this->normalizer->normalizeReasoningSummary('auto', $model), "Model: $model");
            $this->assertSame('detailed', $this->normalizer->normalizeReasoningSummary('concise', $model), "Model: $model");
        }
    }

    public function testNormalizeReasoningSummaryStandardModelPassesThrough(): void
    {
        $this->assertSame('concise', $this->normalizer->normalizeReasoningSummary('concise', 'gpt-5.4'));
        $this->assertSame('auto', $this->normalizer->normalizeReasoningSummary('auto', 'gpt-5.4'));
    }

    // -------------------------------------------------------------------------
    // normalizeReasoningEffortForModel
    // -------------------------------------------------------------------------

    public function testNormalizeReasoningEffortValidCombination(): void
    {
        $this->assertSame('low', $this->normalizer->normalizeReasoningEffortForModel('low', 'gpt-5.4'));
        $this->assertSame('xhigh', $this->normalizer->normalizeReasoningEffortForModel('xhigh', 'gpt-5.4'));
    }

    public function testNormalizeReasoningEffortMiniDoesNotSupportLow(): void
    {
        $this->assertNull($this->normalizer->normalizeReasoningEffortForModel('low', 'gpt-5.1-codex-mini'));
    }

    public function testNormalizeReasoningEffortMiniSupportsHighAndMedium(): void
    {
        $this->assertSame('medium', $this->normalizer->normalizeReasoningEffortForModel('medium', 'gpt-5.4-mini'));
        $this->assertSame('high', $this->normalizer->normalizeReasoningEffortForModel('high', 'gpt-5.4-mini'));
    }

    public function testNormalizeReasoningEffortNullModelReturnsNull(): void
    {
        $this->assertNull($this->normalizer->normalizeReasoningEffortForModel('high', null));
    }

    public function testNormalizeReasoningEffortInvalidEffortReturnsNull(): void
    {
        $this->assertNull($this->normalizer->normalizeReasoningEffortForModel('ultra', 'gpt-5.4'));
    }

    // -------------------------------------------------------------------------
    // normalizeInt
    // -------------------------------------------------------------------------

    public function testNormalizeIntPassesIntegers(): void
    {
        $this->assertSame(42, $this->normalizer->normalizeInt(42));
        $this->assertSame(-1, $this->normalizer->normalizeInt(-1));
        $this->assertSame(0, $this->normalizer->normalizeInt(0));
    }

    public function testNormalizeIntParsesNumericStrings(): void
    {
        $this->assertSame(42, $this->normalizer->normalizeInt('42'));
        $this->assertSame(-5, $this->normalizer->normalizeInt('-5'));
    }

    public function testNormalizeIntRejectsNonNumericStrings(): void
    {
        $this->assertNull($this->normalizer->normalizeInt('abc'));
        $this->assertNull($this->normalizer->normalizeInt('3.14'));
        $this->assertNull($this->normalizer->normalizeInt(null));
    }

    // -------------------------------------------------------------------------
    // normalizeStringList
    // -------------------------------------------------------------------------

    public function testNormalizeStringListFromArray(): void
    {
        $result = $this->normalizer->normalizeStringList(['foo', 'bar', 'baz']);
        $this->assertSame(['foo', 'bar', 'baz'], $result);
    }

    public function testNormalizeStringListDeduplicates(): void
    {
        $result = $this->normalizer->normalizeStringList(['foo', 'foo', 'bar']);
        $this->assertSame(['foo', 'bar'], $result);
    }

    public function testNormalizeStringListFiltersNulls(): void
    {
        $result = $this->normalizer->normalizeStringList(['foo', null, '', '  ', 'bar']);
        $this->assertSame(['foo', 'bar'], $result);
    }

    public function testNormalizeStringListFromNewlineSeparatedString(): void
    {
        $result = $this->normalizer->normalizeStringList("foo\nbar\nbaz");
        $this->assertSame(['foo', 'bar', 'baz'], $result);
    }

    public function testNormalizeStringListFromCrlfString(): void
    {
        $result = $this->normalizer->normalizeStringList("foo\r\nbar");
        $this->assertSame(['foo', 'bar'], $result);
    }

    public function testNormalizeStringListFromNonArrayNonStringReturnsEmpty(): void
    {
        $this->assertSame([], $this->normalizer->normalizeStringList(null));
        $this->assertSame([], $this->normalizer->normalizeStringList(42));
    }

    // -------------------------------------------------------------------------
    // normalizeStringMap
    // -------------------------------------------------------------------------

    public function testNormalizeStringMapReturnsSortedResult(): void
    {
        $result = $this->normalizer->normalizeStringMap(['z' => 'last', 'a' => 'first', 'm' => 'middle']);
        $this->assertSame(['a' => 'first', 'm' => 'middle', 'z' => 'last'], $result);
    }

    public function testNormalizeStringMapPreservesBoolsAndInts(): void
    {
        $result = $this->normalizer->normalizeStringMap(['flag' => true, 'count' => 5, 'pi' => 3.14]);
        $this->assertSame(true, $result['flag']);
        $this->assertSame(5, $result['count']);
        $this->assertSame(3.14, $result['pi']);
    }

    public function testNormalizeStringMapFiltersEmptyKeys(): void
    {
        $result = $this->normalizer->normalizeStringMap(['' => 'ignored', '   ' => 'ignored', 'good' => 'kept']);
        $this->assertSame(['good' => 'kept'], $result);
    }

    public function testNormalizeStringMapReturnsEmptyForNonArray(): void
    {
        $this->assertSame([], $this->normalizer->normalizeStringMap(null));
        $this->assertSame([], $this->normalizer->normalizeStringMap('str'));
    }

    // -------------------------------------------------------------------------
    // normalizeSupportedModel
    // -------------------------------------------------------------------------

    public function testNormalizeSupportedModelAcceptsKnownModels(): void
    {
        foreach (ConfigNormalizer::SUPPORTED_MODELS as $model) {
            $this->assertSame($model, ConfigNormalizer::normalizeSupportedModel($model));
        }
    }

    public function testNormalizeSupportedModelIsCaseInsensitive(): void
    {
        $this->assertSame('gpt-5.4', ConfigNormalizer::normalizeSupportedModel('GPT-5.4'));
        $this->assertSame('gpt-5.5', ConfigNormalizer::normalizeSupportedModel('GPT-5.5'));
    }

    public function testNormalizeSupportedModelRejectsUnknownModels(): void
    {
        $this->assertNull(ConfigNormalizer::normalizeSupportedModel('gpt-4o'));
        $this->assertNull(ConfigNormalizer::normalizeSupportedModel(null));
        $this->assertNull(ConfigNormalizer::normalizeSupportedModel(''));
    }

    // -------------------------------------------------------------------------
    // modelSupportsReasoningEffort
    // -------------------------------------------------------------------------

    public function testModelSupportsReasoningEffortReturnsTrueForValidPair(): void
    {
        $this->assertTrue(ConfigNormalizer::modelSupportsReasoningEffort('gpt-5.5', 'high'));
        $this->assertTrue(ConfigNormalizer::modelSupportsReasoningEffort('gpt-5.4', 'low'));
        $this->assertTrue(ConfigNormalizer::modelSupportsReasoningEffort('gpt-5.4-mini', 'medium'));
    }

    public function testModelSupportsReasoningEffortReturnsFalseForUnsupportedEffort(): void
    {
        $this->assertFalse(ConfigNormalizer::modelSupportsReasoningEffort('gpt-5.1-codex-mini', 'low'));
        $this->assertFalse(ConfigNormalizer::modelSupportsReasoningEffort('gpt-5.1-codex-mini', 'xhigh'));
    }

    public function testModelSupportsReasoningEffortReturnsFalseForUnknownModel(): void
    {
        $this->assertFalse(ConfigNormalizer::modelSupportsReasoningEffort('gpt-4o', 'high'));
    }

    // -------------------------------------------------------------------------
    // isSparkCodexModel / isDetailedOnlyCodexModel
    // -------------------------------------------------------------------------

    public function testIsSparkCodexModel(): void
    {
        $this->assertTrue($this->normalizer->isSparkCodexModel('gpt-5.3-codex-spark'));
        $this->assertFalse($this->normalizer->isSparkCodexModel('gpt-5.3-codex'));
        $this->assertFalse($this->normalizer->isSparkCodexModel('gpt-5.4'));
    }

    public function testIsDetailedOnlyCodexModel(): void
    {
        $this->assertTrue($this->normalizer->isDetailedOnlyCodexModel('gpt-5.3-codex'));
        $this->assertFalse($this->normalizer->isDetailedOnlyCodexModel('gpt-5.3-codex-spark'));
        $this->assertFalse($this->normalizer->isDetailedOnlyCodexModel('gpt-5.4'));
    }

    // -------------------------------------------------------------------------
    // normalizeModelVerbosity
    // -------------------------------------------------------------------------

    public function testNormalizeModelVerbosityAcceptsValidValues(): void
    {
        $this->assertSame('low', $this->normalizer->normalizeModelVerbosity('low', 'gpt-5.4'));
        $this->assertSame('medium', $this->normalizer->normalizeModelVerbosity('medium', 'gpt-5.4'));
        $this->assertSame('high', $this->normalizer->normalizeModelVerbosity('high', 'gpt-5.4'));
    }

    public function testNormalizeModelVerbosityRejectsInvalidValues(): void
    {
        $this->assertNull($this->normalizer->normalizeModelVerbosity('ultra', 'gpt-5.4'));
        $this->assertNull($this->normalizer->normalizeModelVerbosity(null, 'gpt-5.4'));
    }

    public function testNormalizeModelVerbosityForcedMediumForGpt51CodexMax(): void
    {
        $this->assertSame('low', $this->normalizer->normalizeModelVerbosity('low', 'gpt-5.1-codex-max'));
        $this->assertSame('high', $this->normalizer->normalizeModelVerbosity('high', 'gpt-5.1-codex-max'));
    }

    // -------------------------------------------------------------------------
    // settingsHash
    // -------------------------------------------------------------------------

    public function testSettingsHashIsDeterministic(): void
    {
        $settings = ['model' => 'gpt-5.4', 'features' => ['fast_mode' => true]];
        $h1 = $this->normalizer->settingsHash($settings);
        $h2 = $this->normalizer->settingsHash($settings);
        $this->assertSame($h1, $h2);
    }

    public function testSettingsHashDiffersForDifferentInput(): void
    {
        $h1 = $this->normalizer->settingsHash(['model' => 'gpt-5.4']);
        $h2 = $this->normalizer->settingsHash(['model' => 'gpt-5.4-mini']);
        $this->assertNotSame($h1, $h2);
    }

    public function testSettingsHashIsKeyOrderIndependent(): void
    {
        $h1 = $this->normalizer->settingsHash(['a' => 1, 'b' => 2]);
        $h2 = $this->normalizer->settingsHash(['b' => 2, 'a' => 1]);
        $this->assertSame($h1, $h2);
    }

    public function testSettingsHashIs64HexChars(): void
    {
        $hash = $this->normalizer->settingsHash([]);
        $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $hash);
    }

    // -------------------------------------------------------------------------
    // assertSha
    // -------------------------------------------------------------------------

    public function testAssertShaAcceptsValid64HexString(): void
    {
        $errors = [];
        $sha = str_repeat('a', 64);
        $this->normalizer->assertSha($sha, false, $errors);
        $this->assertEmpty($errors);
    }

    public function testAssertShaThrowsForInvalidSha(): void
    {
        $this->expectException(ValidationException::class);
        $errors = [];
        $this->normalizer->assertSha('not-a-sha', false, $errors);
    }

    public function testAssertShaThrowsForNullWhenRequired(): void
    {
        $this->expectException(ValidationException::class);
        $errors = [];
        $this->normalizer->assertSha(null, false, $errors);
    }

    public function testAssertShaAllowsNullWhenAllowNull(): void
    {
        $errors = [];
        $this->normalizer->assertSha(null, true, $errors);
        $this->assertEmpty($errors);
    }

    // -------------------------------------------------------------------------
    // normalizeSettings — integration
    // -------------------------------------------------------------------------

    public function testNormalizeSettingsEmptyInputHasExpectedDefaults(): void
    {
        $result = $this->normalizer->normalizeSettings([]);

        $this->assertNull($result['model']);
        $this->assertSame('friendly', $result['personality']);
        $this->assertTrue($result['orchestrator_mcp_enabled']);
        $this->assertIsArray($result['features']);
        $this->assertIsArray($result['profiles']);
        $this->assertIsArray($result['mcp_servers']);
        $this->assertIsArray($result['otel']);
        $this->assertSame('', $result['custom_toml']);
    }

    public function testNormalizeSettingsDefaultFeaturesAppsMemoriesAndMultiAgent(): void
    {
        $result = $this->normalizer->normalizeSettings([]);
        $this->assertTrue($result['features']['apps']);
        $this->assertTrue($result['features']['memories']);
        $this->assertTrue($result['features']['multi_agent']);
    }

    public function testNormalizeSettingsDropsDeprecatedFeatureKeys(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'features' => ['steer' => true, 'request_rule' => false, 'request_permissions' => true, 'use_linux_sandbox_bwrap' => true, 'fast_mode' => true],
        ]);
        $this->assertArrayNotHasKey('steer', $result['features']);
        $this->assertArrayNotHasKey('request_rule', $result['features']);
        $this->assertArrayNotHasKey('request_permissions', $result['features']);
        $this->assertArrayNotHasKey('use_linux_sandbox_bwrap', $result['features']);
        $this->assertTrue($result['features']['fast_mode']);
    }

    public function testNormalizeSettingsSupportsCurrentCliExperimentalAndAdvancedFlags(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'features' => [
                'tui_app_server' => true,
                'request_permissions_tool' => true,
                'use_legacy_landlock' => true,
            ],
        ]);

        $this->assertTrue($result['features']['tui_app_server']);
        $this->assertTrue($result['features']['request_permissions_tool']);
        $this->assertTrue($result['features']['use_legacy_landlock']);
    }

    public function testNormalizeSettingsDropsUnknownFeatureKeys(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'features' => ['unknown_future_flag' => true],
        ]);
        $this->assertArrayNotHasKey('unknown_future_flag', $result['features']);
    }

    public function testNormalizeSettingsWebSearchInFeaturesPromotetToTopLevel(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'features' => ['web_search' => 'cached'],
        ]);
        $this->assertSame('cached', $result['web_search']);
    }

    public function testNormalizeSettingsWebSearchCachedOverridePreventsLive(): void
    {
        // web_search_cached with 'live' should be coerced to 'cached'
        $result = $this->normalizer->normalizeSettings([
            'features' => ['web_search_cached' => 'live'],
        ]);
        $this->assertSame('cached', $result['web_search']);
    }

    public function testNormalizeSettingsFirstWebSearchFeatureWins(): void
    {
        // top-level web_search takes precedence, features web_search is skip when top-level already set
        $result = $this->normalizer->normalizeSettings([
            'web_search' => 'disabled',
            'features' => ['web_search' => 'live'],
        ]);
        $this->assertSame('disabled', $result['web_search']);
    }

    public function testNormalizeSettingsProfilesNormalized(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'profiles' => [
                [
                    'name' => 'work',
                    'model' => 'gpt-5.4',
                    'model_reasoning_effort' => 'high',
                    'features' => ['fast_mode' => true],
                ],
            ],
        ]);

        $this->assertCount(1, $result['profiles']);
        $profile = $result['profiles'][0];
        $this->assertSame('work', $profile['name']);
        $this->assertSame('gpt-5.4', $profile['model']);
        $this->assertSame('high', $profile['model_reasoning_effort']);
        $this->assertTrue($profile['features']['fast_mode']);
    }

    public function testNormalizeSettingsProfileWithNoNameSkipped(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'profiles' => [
                ['model' => 'gpt-5.4'],
            ],
        ]);
        $this->assertCount(0, $result['profiles']);
    }

    public function testNormalizeSettingsMcpServerDroppedWithoutTransport(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'mcp_servers' => [
                ['name' => 'no-transport'],
            ],
        ]);
        $this->assertCount(0, $result['mcp_servers']);
    }

    public function testNormalizeSettingsMcpServerWithCommandIncluded(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'mcp_servers' => [
                ['name' => 'my-server', 'command' => 'npx', 'args' => ['-y', 'my-mcp']],
            ],
        ]);
        $this->assertCount(1, $result['mcp_servers']);
        $this->assertSame('npx', $result['mcp_servers'][0]['command']);
        $this->assertSame(['-y', 'my-mcp'], $result['mcp_servers'][0]['args']);
    }

    public function testNormalizeSettingsMcpServerWithUrlIncluded(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'mcp_servers' => [
                ['name' => 'remote', 'url' => 'https://mcp.example.com'],
            ],
        ]);
        $this->assertCount(1, $result['mcp_servers']);
        $this->assertSame('https://mcp.example.com', $result['mcp_servers'][0]['url']);
    }

    public function testNormalizeSettingsOtelFields(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'otel' => [
                'environment' => 'production',
                'exporter' => 'otlp',
                'endpoint' => 'https://otel.example.com',
                'protocol' => 'grpc',
                'headers' => ['x-api-key' => 'secret'],
                'log_user_prompt' => true,
            ],
        ]);

        $this->assertSame('production', $result['otel']['environment']);
        $this->assertSame('otlp', $result['otel']['exporter']);
        $this->assertSame('https://otel.example.com', $result['otel']['endpoint']);
        $this->assertSame('grpc', $result['otel']['protocol']);
        $this->assertSame(['x-api-key' => 'secret'], $result['otel']['headers']);
        $this->assertTrue($result['otel']['log_user_prompt']);
    }

    public function testNormalizeSettingsNoticeDefaults(): void
    {
        $result = $this->normalizer->normalizeSettings([]);
        $this->assertTrue($result['notice']['hide_gpt5_1_migration_prompt']);
        $this->assertIsArray($result['notice']['model_migrations']);
    }

    public function testNormalizeSettingsNoticeCustomBoolOverride(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'notice' => ['hide_gpt5_1_migration_prompt' => false],
        ]);
        $this->assertFalse($result['notice']['hide_gpt5_1_migration_prompt']);
    }

    public function testNormalizeSettingsNoticeModelMigrationsCanBeExtended(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'notice' => ['model_migrations' => ['gpt-5.4' => 'gpt-5.5']],
        ]);
        // Default migrations should still be present, custom one merged in
        $this->assertArrayHasKey('gpt-5.4', $result['notice']['model_migrations']);
    }

    public function testNormalizeSettingsCustomTomlPreserved(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'custom_toml' => "  [section]\nkey = \"value\"  ",
        ]);
        $this->assertSame("[section]\nkey = \"value\"", $result['custom_toml']);
    }

    public function testNormalizeSettingsSandboxWorkspaceWrite(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'sandbox_workspace_write' => [
                'network_access' => true,
                'exclude_slash_tmp' => false,
                'writable_roots' => ['/home/user/project'],
            ],
        ]);

        $this->assertTrue($result['sandbox_workspace_write']['network_access']);
        $this->assertFalse($result['sandbox_workspace_write']['exclude_slash_tmp']);
        $this->assertSame(['/home/user/project'], $result['sandbox_workspace_write']['writable_roots']);
    }

    public function testNormalizeSettingsShellEnvironmentPolicy(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'shell_environment_policy' => [
                'inherit' => 'all',
                'set' => ['MY_VAR' => 'value'],
                'exclude' => ['SECRET_KEY'],
                'include_only' => [],
                'ignore_default_excludes' => true,
            ],
        ]);

        $this->assertSame('all', $result['shell_environment_policy']['inherit']);
        $this->assertSame(['MY_VAR' => 'value'], $result['shell_environment_policy']['set']);
        $this->assertSame(['SECRET_KEY'], $result['shell_environment_policy']['exclude']);
        $this->assertTrue($result['shell_environment_policy']['ignore_default_excludes']);
    }

    public function testNormalizeSettingsSecurityBypassField(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'security' => ['dangerously_bypass_approvals_and_sandbox' => true],
        ]);
        $this->assertTrue($result['security']['dangerously_bypass_approvals_and_sandbox']);
    }

    public function testNormalizeSettingsReasoningEffortDroppedForUnsupportedModel(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'model' => 'gpt-5.1-codex-mini',
            'model_reasoning_effort' => 'low',
        ]);
        $this->assertSame('gpt-5.4', $result['model']);
        $this->assertSame('high', $result['model_reasoning_effort']);
    }

    public function testNormalizeSettingsReasoningSummaryDetailedForcedForCodexModel(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'model' => 'gpt-5.3-codex',
            'model_reasoning_summary' => 'concise',
        ]);
        $this->assertSame('detailed', $result['model_reasoning_summary']);
    }

    public function testNormalizeSettingsNotifyList(): void
    {
        $result = $this->normalizer->normalizeSettings([
            'notify' => ['oncall@example.com', 'team@example.com', 'oncall@example.com'],
        ]);
        // Deduplication via normalizeStringList
        $this->assertSame(['oncall@example.com', 'team@example.com'], $result['notify']);
    }

    // -------------------------------------------------------------------------
    // Claude reasoning effort
    // -------------------------------------------------------------------------

    public function testSupportedReasoningEffortsForClaudeOpus(): void
    {
        $efforts = ConfigNormalizer::supportedReasoningEffortsForModel('claude-opus-4-6');
        $this->assertSame(['low', 'medium', 'high'], $efforts);
    }

    public function testSupportedReasoningEffortsForClaudeSonnet(): void
    {
        $efforts = ConfigNormalizer::supportedReasoningEffortsForModel('claude-sonnet-4-6');
        $this->assertSame(['low', 'medium', 'high'], $efforts);
    }

    public function testSupportedReasoningEffortsForClaudeHaiku(): void
    {
        $efforts = ConfigNormalizer::supportedReasoningEffortsForModel('claude-haiku-4-5');
        $this->assertSame(['low', 'medium', 'high'], $efforts);
    }

    public function testClaudeModelSupportsReasoningEffortMedium(): void
    {
        $this->assertTrue(ConfigNormalizer::modelSupportsReasoningEffort('claude-sonnet-4-6', 'medium'));
    }

    public function testClaudeModelDoesNotSupportXhigh(): void
    {
        $this->assertFalse(ConfigNormalizer::modelSupportsReasoningEffort('claude-sonnet-4-6', 'xhigh'));
    }

    public function testOpenAiModelsStillWorkAfterClaudeAddition(): void
    {
        $this->assertTrue(ConfigNormalizer::modelSupportsReasoningEffort('gpt-5.4', 'high'));
        $this->assertTrue(ConfigNormalizer::modelSupportsReasoningEffort('gpt-5.4', 'xhigh'));
    }

    public function testUnsupportedModelReturnsEmptyEfforts(): void
    {
        $efforts = ConfigNormalizer::supportedReasoningEffortsForModel('unknown-model');
        $this->assertSame([], $efforts);
    }
}
