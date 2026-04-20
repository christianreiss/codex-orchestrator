<?php

declare(strict_types=1);

use App\Exceptions\ValidationException;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\RunnerValidationService;
use App\Services\RunnerVerifier;
use App\Support\Engine;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

/**
 * Unit tests for RunnerValidationService.
 *
 * Covers pure / near-pure public methods that can be exercised without a
 * database connection:
 *   - parseTimestamp()
 *   - calculateDigest()
 *   - ensureAuthsFallback()
 *   - buildAuthArrayFromEntries()
 *   - canonicalizeAuthPayload()
 *   - canonicalAuthFromPayload()
 *   - assertReasonableLastRefresh()
 *   - normalizeAuthEntries()
 *   - recordRunnerOutcome()    (writes to mocked VersionRepository)
 *   - isRunnerFailing()        (reads from mocked VersionRepository)
 *   - resolveRunnerHost()      (reads from mocked HostRepository)
 *   - canonicalAuthSnapshot()  (resolves/validates canonical payload)
 *
 * Methods that require full integration (runDailyPreflight, runnerDailyCheck,
 * runRunnerValidationAttempt, enforceRunnerValidationOnFailure, triggerRunnerRefresh)
 * are covered by the broader AuthService/Runner integration tests.
 */
final class RunnerValidationServiceTest extends TestCase
{
    private RunnerValidationService $svc;

    /** @var HostRepository&\PHPUnit\Framework\MockObject\MockObject */
    private HostRepository $hosts;

    /** @var AuthPayloadRepository&\PHPUnit\Framework\MockObject\MockObject */
    private AuthPayloadRepository $payloads;

    /** @var HostAuthStateRepository&\PHPUnit\Framework\MockObject\MockObject */
    private HostAuthStateRepository $hostStates;

    /** @var LogRepository&\PHPUnit\Framework\MockObject\MockObject */
    private LogRepository $logs;

    /** @var VersionRepository&\PHPUnit\Framework\MockObject\MockObject */
    private VersionRepository $versions;

    private const VALID_TOKEN = 'sk-abcdefghijklmnopqrstuvwxyz9876';
    private const VALID_LAST_REFRESH = '2024-06-15T12:00:00Z';

    protected function setUp(): void
    {
        $this->hosts = $this->getMockBuilder(HostRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $this->payloads = $this->getMockBuilder(AuthPayloadRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $this->hostStates = $this->getMockBuilder(HostAuthStateRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $this->logs = $this->getMockBuilder(LogRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $this->versions = $this->getMockBuilder(VersionRepository::class)
            ->disableOriginalConstructor()
            ->getMock();

        $this->svc = new RunnerValidationService(
            $this->hosts,
            $this->payloads,
            $this->hostStates,
            $this->logs,
            $this->versions,
            null
        );
    }

    // -------------------------------------------------------------------------
    // parseTimestamp
    // -------------------------------------------------------------------------

    public function testParseTimestampReturnsNullForNull(): void
    {
        $this->assertNull($this->svc->parseTimestamp(null));
    }

    public function testParseTimestampReturnsNullForEmptyString(): void
    {
        $this->assertNull($this->svc->parseTimestamp(''));
    }

    public function testParseTimestampReturnsNullForInvalidString(): void
    {
        $this->assertNull($this->svc->parseTimestamp('not-a-date'));
    }

    public function testParseTimestampReturnsIntForValidRfc3339(): void
    {
        $ts = $this->svc->parseTimestamp('2024-06-15T12:00:00Z');
        $this->assertIsInt($ts);
        $this->assertSame(strtotime('2024-06-15T12:00:00Z'), $ts);
    }

    public function testParseTimestampReturnsIntForValidDateString(): void
    {
        $ts = $this->svc->parseTimestamp('2023-01-01 00:00:00');
        $this->assertIsInt($ts);
    }

    // -------------------------------------------------------------------------
    // calculateDigest
    // -------------------------------------------------------------------------

    public function testCalculateDigestReturnsNullForNull(): void
    {
        $this->assertNull($this->svc->calculateDigest(null));
    }

    public function testCalculateDigestReturnsNullForEmptyString(): void
    {
        $this->assertNull($this->svc->calculateDigest(''));
    }

    public function testCalculateDigestReturnsSha256ForValidInput(): void
    {
        $input = '{"last_refresh":"2024-01-01T00:00:00Z"}';
        $digest = $this->svc->calculateDigest($input);
        $this->assertIsString($digest);
        $this->assertSame(64, strlen($digest));
        $this->assertSame(hash('sha256', $input), $digest);
    }

    public function testCalculateDigestIsDeterministic(): void
    {
        $input = '{"test":1}';
        $this->assertSame(
            $this->svc->calculateDigest($input),
            $this->svc->calculateDigest($input)
        );
    }

    public function testCalculateDigestDiffersForDifferentInputs(): void
    {
        $this->assertNotSame(
            $this->svc->calculateDigest('{"a":1}'),
            $this->svc->calculateDigest('{"a":2}')
        );
    }

    // -------------------------------------------------------------------------
    // ensureAuthsFallback
    // -------------------------------------------------------------------------

    public function testEnsureAuthsFallbackReturnsUnchangedWhenAuthsPresent(): void
    {
        $payload = [
            'auths' => [
                'api.openai.com' => ['token' => self::VALID_TOKEN],
            ],
            'last_refresh' => self::VALID_LAST_REFRESH,
        ];
        $result = $this->svc->ensureAuthsFallback($payload);
        $this->assertSame($payload, $result);
    }

    public function testEnsureAuthsFallbackSynthesizesFromTokensAccessToken(): void
    {
        $payload = [
            'tokens' => ['access_token' => self::VALID_TOKEN],
            'last_refresh' => self::VALID_LAST_REFRESH,
        ];
        $result = $this->svc->ensureAuthsFallback($payload);
        $this->assertArrayHasKey('auths', $result);
        $this->assertArrayHasKey('api.openai.com', $result['auths']);
        $this->assertSame(self::VALID_TOKEN, $result['auths']['api.openai.com']['token']);
    }

    public function testEnsureAuthsFallbackSynthesizesFromOpenAiApiKey(): void
    {
        $payload = [
            'OPENAI_API_KEY' => self::VALID_TOKEN,
            'last_refresh' => self::VALID_LAST_REFRESH,
        ];
        $result = $this->svc->ensureAuthsFallback($payload);
        $this->assertArrayHasKey('auths', $result);
        $this->assertSame(self::VALID_TOKEN, $result['auths']['api.openai.com']['token']);
    }

    public function testEnsureAuthsFallbackSynthesizesClaudeApiKey(): void
    {
        $payload = [
            'api_key' => self::VALID_TOKEN,
            'last_refresh' => self::VALID_LAST_REFRESH,
        ];
        $result = $this->svc->ensureAuthsFallback($payload, Engine::CLAUDE);
        $this->assertArrayHasKey('auths', $result);
        $this->assertSame(self::VALID_TOKEN, $result['auths']['api.anthropic.com']['token']);
        $this->assertSame('bearer', $result['auths']['api.anthropic.com']['token_type']);
    }

    public function testEnsureAuthsFallbackPrefersTokensOverOpenAiApiKey(): void
    {
        $tokenFromTokens = 'sk-from-tokens-aaabbbcccdddeee0001';
        $tokenFromEnv = 'sk-from-env-aaabbbcccdddeee0002';
        $payload = [
            'tokens' => ['access_token' => $tokenFromTokens],
            'OPENAI_API_KEY' => $tokenFromEnv,
            'last_refresh' => self::VALID_LAST_REFRESH,
        ];
        $result = $this->svc->ensureAuthsFallback($payload);
        $this->assertSame($tokenFromTokens, $result['auths']['api.openai.com']['token']);
    }

    public function testEnsureAuthsFallbackReturnsUnchangedWhenNoTokensAvailable(): void
    {
        $payload = ['last_refresh' => self::VALID_LAST_REFRESH];
        $result = $this->svc->ensureAuthsFallback($payload);
        $this->assertArrayNotHasKey('auths', $result);
    }

    public function testEnsureAuthsFallbackSkipsEmptyAccessToken(): void
    {
        $payload = [
            'tokens' => ['access_token' => '   '],
            'last_refresh' => self::VALID_LAST_REFRESH,
        ];
        $result = $this->svc->ensureAuthsFallback($payload);
        $this->assertArrayNotHasKey('auths', $result);
    }

    // -------------------------------------------------------------------------
    // buildAuthArrayFromEntries
    // -------------------------------------------------------------------------

    public function testBuildAuthArrayFromEntriesReturnsCorrectStructure(): void
    {
        $entries = [
            [
                'target' => 'api.openai.com',
                'token' => self::VALID_TOKEN,
                'token_type' => 'bearer',
                'organization' => null,
                'project' => null,
                'api_base' => null,
                'meta' => null,
            ],
        ];
        $result = $this->svc->buildAuthArrayFromEntries(self::VALID_LAST_REFRESH, $entries);

        $this->assertSame(self::VALID_LAST_REFRESH, $result['last_refresh']);
        $this->assertArrayHasKey('api.openai.com', $result['auths']);
        $this->assertSame(self::VALID_TOKEN, $result['auths']['api.openai.com']['token']);
        $this->assertSame('bearer', $result['auths']['api.openai.com']['token_type']);
    }

    public function testBuildAuthArrayFromEntriesOmitsNullFields(): void
    {
        $entries = [
            [
                'target' => 'api.openai.com',
                'token' => self::VALID_TOKEN,
                'token_type' => null,
                'organization' => null,
                'project' => null,
                'api_base' => null,
                'meta' => null,
            ],
        ];
        $result = $this->svc->buildAuthArrayFromEntries(self::VALID_LAST_REFRESH, $entries);
        $item = $result['auths']['api.openai.com'];
        $this->assertArrayNotHasKey('organization', $item);
        $this->assertArrayNotHasKey('project', $item);
        $this->assertArrayNotHasKey('api_base', $item);
    }

    public function testBuildAuthArrayFromEntriesIncludesOptionalFields(): void
    {
        $entries = [
            [
                'target' => 'api.openai.com',
                'token' => self::VALID_TOKEN,
                'token_type' => 'bearer',
                'organization' => 'org-abc',
                'project' => 'proj-xyz',
                'api_base' => 'https://api.example.com/v1',
                'meta' => null,
            ],
        ];
        $result = $this->svc->buildAuthArrayFromEntries(self::VALID_LAST_REFRESH, $entries);
        $item = $result['auths']['api.openai.com'];
        $this->assertSame('org-abc', $item['organization']);
        $this->assertSame('proj-xyz', $item['project']);
        $this->assertSame('https://api.example.com/v1', $item['api_base']);
    }

    public function testBuildAuthArrayFromEntriesSpreadsMeta(): void
    {
        $entries = [
            [
                'target' => 'api.openai.com',
                'token' => self::VALID_TOKEN,
                'token_type' => 'bearer',
                'organization' => null,
                'project' => null,
                'api_base' => null,
                'meta' => ['custom_field' => 'custom_value'],
            ],
        ];
        $result = $this->svc->buildAuthArrayFromEntries(self::VALID_LAST_REFRESH, $entries);
        $this->assertSame('custom_value', $result['auths']['api.openai.com']['custom_field']);
    }

    public function testBuildAuthArrayFromEntriesSortsTargetsAlphabetically(): void
    {
        $entries = [
            ['target' => 'z.example.com', 'token' => self::VALID_TOKEN, 'token_type' => 'bearer', 'organization' => null, 'project' => null, 'api_base' => null, 'meta' => null],
            ['target' => 'a.example.com', 'token' => self::VALID_TOKEN, 'token_type' => 'bearer', 'organization' => null, 'project' => null, 'api_base' => null, 'meta' => null],
        ];
        $result = $this->svc->buildAuthArrayFromEntries(self::VALID_LAST_REFRESH, $entries);
        $keys = array_keys($result['auths']);
        $this->assertSame('a.example.com', $keys[0]);
        $this->assertSame('z.example.com', $keys[1]);
    }

    public function testBuildAuthArrayFromEntriesSortsItemKeysAlphabetically(): void
    {
        $entries = [
            [
                'target' => 'api.openai.com',
                'token' => self::VALID_TOKEN,
                'token_type' => 'bearer',
                'organization' => 'org-abc',
                'project' => null,
                'api_base' => null,
                'meta' => null,
            ],
        ];
        $result = $this->svc->buildAuthArrayFromEntries(self::VALID_LAST_REFRESH, $entries);
        $keys = array_keys($result['auths']['api.openai.com']);
        $sorted = $keys;
        sort($sorted);
        $this->assertSame($sorted, $keys);
    }

    // -------------------------------------------------------------------------
    // canonicalizeAuthPayload
    // -------------------------------------------------------------------------

    public function testCanonicalizeAuthPayloadSetsLastRefreshAndAuhs(): void
    {
        $entries = [
            ['target' => 'api.openai.com', 'token' => self::VALID_TOKEN, 'token_type' => 'bearer', 'organization' => null, 'project' => null, 'api_base' => null, 'meta' => null],
        ];
        $incoming = ['last_refresh' => 'old', 'extra_key' => 'preserved'];
        $result = $this->svc->canonicalizeAuthPayload($incoming, $entries, self::VALID_LAST_REFRESH);

        $this->assertSame(self::VALID_LAST_REFRESH, $result['last_refresh']);
        $this->assertArrayHasKey('auths', $result);
        $this->assertSame('preserved', $result['extra_key']);
    }

    // -------------------------------------------------------------------------
    // canonicalAuthFromPayload
    // -------------------------------------------------------------------------

    public function testCanonicalAuthFromPayloadDecodesBodyWhenPresent(): void
    {
        $auth = ['last_refresh' => self::VALID_LAST_REFRESH, 'auths' => []];
        $body = json_encode($auth);
        $payload = ['body' => $body, 'last_refresh' => 'ignored', 'entries' => []];

        $result = $this->svc->canonicalAuthFromPayload($payload);
        $this->assertSame($auth, $result);
    }

    public function testCanonicalAuthFromPayloadFallsBackToEntriesWhenBodyAbsent(): void
    {
        $payload = [
            'last_refresh' => self::VALID_LAST_REFRESH,
            'entries' => [
                ['target' => 'api.openai.com', 'token' => self::VALID_TOKEN, 'token_type' => 'bearer', 'organization' => null, 'project' => null, 'api_base' => null, 'meta' => null],
            ],
        ];
        $result = $this->svc->canonicalAuthFromPayload($payload);
        $this->assertSame(self::VALID_LAST_REFRESH, $result['last_refresh']);
        $this->assertArrayHasKey('auths', $result);
    }

    public function testCanonicalAuthFromPayloadFallsBackToEntriesWhenBodyInvalidJson(): void
    {
        $payload = [
            'body' => 'not-valid-json',
            'last_refresh' => self::VALID_LAST_REFRESH,
            'entries' => [],
        ];
        $result = $this->svc->canonicalAuthFromPayload($payload);
        $this->assertSame(self::VALID_LAST_REFRESH, $result['last_refresh']);
    }

    // -------------------------------------------------------------------------
    // assertReasonableLastRefresh
    // -------------------------------------------------------------------------

    public function testAssertReasonableLastRefreshAcceptsValidTimestamp(): void
    {
        // Should not throw
        $this->svc->assertReasonableLastRefresh(self::VALID_LAST_REFRESH, 'last_refresh');
        $this->addToAssertionCount(1);
    }

    public function testAssertReasonableLastRefreshThrowsForInvalidString(): void
    {
        $this->expectException(ValidationException::class);
        $this->svc->assertReasonableLastRefresh('not-a-date', 'last_refresh');
    }

    public function testAssertReasonableLastRefreshThrowsForImplausiblyOldTimestamp(): void
    {
        $this->expectException(ValidationException::class);
        $this->svc->assertReasonableLastRefresh('1999-12-31T23:59:59Z', 'last_refresh');
    }

    public function testAssertReasonableLastRefreshThrowsForFutureTimestamp(): void
    {
        $future = gmdate(DATE_ATOM, time() + 3600);
        $this->expectException(ValidationException::class);
        $this->svc->assertReasonableLastRefresh($future, 'last_refresh');
    }

    public function testAssertReasonableLastRefreshAcceptsTimestampSlightlyInFuture(): void
    {
        // Within the 300-second skew window
        $slightlyFuture = gmdate(DATE_ATOM, time() + 60);
        $this->svc->assertReasonableLastRefresh($slightlyFuture, 'last_refresh');
        $this->addToAssertionCount(1);
    }

    // -------------------------------------------------------------------------
    // normalizeAuthEntries
    // -------------------------------------------------------------------------

    public function testNormalizeAuthEntriesReturnsSingleEntry(): void
    {
        $auth = [
            'last_refresh' => self::VALID_LAST_REFRESH,
            'auths' => [
                'api.openai.com' => ['token' => self::VALID_TOKEN],
            ],
        ];
        $entries = $this->svc->normalizeAuthEntries($auth);
        $this->assertCount(1, $entries);
        $this->assertSame('api.openai.com', $entries[0]['target']);
        $this->assertSame(self::VALID_TOKEN, $entries[0]['token']);
        $this->assertSame('bearer', $entries[0]['token_type']);
    }

    public function testNormalizeAuthEntriesSynthesizesClaudeEntryFromApiKey(): void
    {
        $auth = [
            'last_refresh' => self::VALID_LAST_REFRESH,
            'anthropic_api_key' => self::VALID_TOKEN,
        ];
        $entries = $this->svc->normalizeAuthEntries($auth, Engine::CLAUDE);
        $this->assertCount(1, $entries);
        $this->assertSame('api.anthropic.com', $entries[0]['target']);
        $this->assertSame(self::VALID_TOKEN, $entries[0]['token']);
    }

    public function testNormalizeAuthEntriesPreservesOrganizationAndProject(): void
    {
        $auth = [
            'auths' => [
                'api.openai.com' => [
                    'token' => self::VALID_TOKEN,
                    'organization' => 'org-test',
                    'project' => 'proj-test',
                ],
            ],
        ];
        $entries = $this->svc->normalizeAuthEntries($auth);
        $this->assertSame('org-test', $entries[0]['organization']);
        $this->assertSame('proj-test', $entries[0]['project']);
    }

    public function testNormalizeAuthEntriesAcceptsAliasFieldNames(): void
    {
        $auth = [
            'auths' => [
                'api.openai.com' => [
                    'token' => self::VALID_TOKEN,
                    'type' => 'bearer',              // alias for token_type
                    'org' => 'org-abc',              // alias for organization
                    'default_project' => 'proj-def', // alias for project
                    'base_url' => 'https://api.example.com', // alias for api_base
                ],
            ],
        ];
        $entries = $this->svc->normalizeAuthEntries($auth);
        $this->assertSame('bearer', $entries[0]['token_type']);
        $this->assertSame('org-abc', $entries[0]['organization']);
        $this->assertSame('proj-def', $entries[0]['project']);
        $this->assertSame('https://api.example.com', $entries[0]['api_base']);
    }

    public function testNormalizeAuthEntriesStoresUnknownFieldsInMeta(): void
    {
        $auth = [
            'auths' => [
                'api.openai.com' => [
                    'token' => self::VALID_TOKEN,
                    'custom_key' => 'custom_val',
                ],
            ],
        ];
        $entries = $this->svc->normalizeAuthEntries($auth);
        $this->assertIsArray($entries[0]['meta']);
        $this->assertSame('custom_val', $entries[0]['meta']['custom_key']);
    }

    public function testNormalizeAuthEntriesThrowsWhenNoAuthsAndNoFallback(): void
    {
        $this->expectException(ValidationException::class);
        $this->svc->normalizeAuthEntries(['last_refresh' => self::VALID_LAST_REFRESH]);
    }

    public function testNormalizeAuthEntriesThrowsWhenAuthsIsEmpty(): void
    {
        $this->expectException(ValidationException::class);
        $this->svc->normalizeAuthEntries(['auths' => []]);
    }

    public function testNormalizeAuthEntriesThrowsWhenEntryMissingToken(): void
    {
        $this->expectException(ValidationException::class);
        $this->svc->normalizeAuthEntries([
            'auths' => ['api.openai.com' => ['token_type' => 'bearer']],
        ]);
    }

    public function testNormalizeAuthEntriesThrowsForTokenWithWhitespace(): void
    {
        $this->expectException(ValidationException::class);
        $this->svc->normalizeAuthEntries([
            'auths' => ['api.openai.com' => ['token' => "sk-abc def ghijk lmno pqrst uvwxy"]],
        ]);
    }

    public function testNormalizeAuthEntriesThrowsForShortToken(): void
    {
        $this->expectException(ValidationException::class);
        $this->svc->normalizeAuthEntries([
            'auths' => ['api.openai.com' => ['token' => 'sk-short']],
        ]);
    }

    public function testNormalizeAuthEntriesThrowsForPlaceholderToken(): void
    {
        $this->expectException(ValidationException::class);
        $this->svc->normalizeAuthEntries([
            'auths' => ['api.openai.com' => ['token' => 'placeholder']],
        ]);
    }

    public function testNormalizeAuthEntriesThrowsForLowEntropyToken(): void
    {
        $this->expectException(ValidationException::class);
        // Same char repeated — only 1 unique char
        $this->svc->normalizeAuthEntries([
            'auths' => ['api.openai.com' => ['token' => str_repeat('a', 30)]],
        ]);
    }

    public function testNormalizeAuthEntriesFallsBackToTokensWhenNoAuths(): void
    {
        $auth = [
            'tokens' => ['access_token' => self::VALID_TOKEN],
            'last_refresh' => self::VALID_LAST_REFRESH,
        ];
        $entries = $this->svc->normalizeAuthEntries($auth);
        $this->assertCount(1, $entries);
        $this->assertSame(self::VALID_TOKEN, $entries[0]['token']);
    }

    public function testNormalizeAuthEntriesFallsBackToOpenAiApiKeyWhenNoAuths(): void
    {
        $auth = [
            'OPENAI_API_KEY' => self::VALID_TOKEN,
            'last_refresh' => self::VALID_LAST_REFRESH,
        ];
        $entries = $this->svc->normalizeAuthEntries($auth);
        $this->assertCount(1, $entries);
        $this->assertSame(self::VALID_TOKEN, $entries[0]['token']);
    }

    public function testNormalizeAuthEntriesThrowsForNonStringTarget(): void
    {
        $this->expectException(ValidationException::class);
        $auth = ['auths' => ['' => ['token' => self::VALID_TOKEN]]];
        $this->svc->normalizeAuthEntries($auth);
    }

    // -------------------------------------------------------------------------
    // isRunnerFailing
    // -------------------------------------------------------------------------

    public function testIsRunnerFailingReturnsTrueWhenStateFail(): void
    {
        $this->versions->method('get')->with('runner_state')->willReturn('fail');
        $this->assertTrue($this->svc->isRunnerFailing());
    }

    public function testIsRunnerFailingReturnsTrueWhenStateFailUpperCase(): void
    {
        $this->versions->method('get')->with('runner_state')->willReturn('FAIL');
        $this->assertTrue($this->svc->isRunnerFailing());
    }

    public function testIsRunnerFailingReturnsFalseWhenStateOk(): void
    {
        $this->versions->method('get')->with('runner_state')->willReturn('ok');
        $this->assertFalse($this->svc->isRunnerFailing());
    }

    public function testIsRunnerFailingReturnsFalseWhenStateNull(): void
    {
        $this->versions->method('get')->with('runner_state')->willReturn(null);
        $this->assertFalse($this->svc->isRunnerFailing());
    }

    public function testIsRunnerFailingReturnsFalseWhenStateEmpty(): void
    {
        $this->versions->method('get')->with('runner_state')->willReturn('');
        $this->assertFalse($this->svc->isRunnerFailing());
    }

    // -------------------------------------------------------------------------
    // recordRunnerOutcome
    // -------------------------------------------------------------------------

    public function testRecordRunnerOutcomeSetsStateOkOnOkStatus(): void
    {
        $called = [];
        $this->versions->method('set')->willReturnCallback(function ($key, $value) use (&$called) {
            $called[$key] = $value;
        });

        $this->svc->recordRunnerOutcome(['status' => 'ok'], true, 'test');

        $this->assertSame('ok', $called['runner_state']);
        $this->assertArrayHasKey('runner_last_ok', $called);
        $this->assertArrayHasKey('runner_last_check', $called);
    }

    public function testRecordRunnerOutcomeSetsStateFailOnNonOkStatus(): void
    {
        $called = [];
        $this->versions->method('set')->willReturnCallback(function ($key, $value) use (&$called) {
            $called[$key] = $value;
        });

        $this->svc->recordRunnerOutcome(['status' => 'fail'], false, 'test');

        $this->assertSame('fail', $called['runner_state']);
        $this->assertArrayHasKey('runner_last_fail', $called);
    }

    public function testRecordRunnerOutcomeSetsLastCheckWhenNotReachable(): void
    {
        $called = [];
        $this->versions->method('set')->willReturnCallback(function ($key, $value) use (&$called) {
            $called[$key] = $value;
        });

        $this->svc->recordRunnerOutcome(['status' => 'fail'], false, 'test');

        $this->assertArrayHasKey('runner_last_check', $called);
    }

    public function testRecordRunnerOutcomeSetsLastCheckWhenReachable(): void
    {
        $called = [];
        $this->versions->method('set')->willReturnCallback(function ($key, $value) use (&$called) {
            $called[$key] = $value;
        });

        $this->svc->recordRunnerOutcome(['status' => 'fail'], true, 'test');

        $this->assertArrayHasKey('runner_last_check', $called);
    }

    public function testRecordRunnerOutcomeIsCaseInsensitiveForStatus(): void
    {
        $called = [];
        $this->versions->method('set')->willReturnCallback(function ($key, $value) use (&$called) {
            $called[$key] = $value;
        });

        $this->svc->recordRunnerOutcome(['status' => 'OK'], true, 'test');

        $this->assertSame('ok', $called['runner_state']);
    }

    // -------------------------------------------------------------------------
    // resolveRunnerHost
    // -------------------------------------------------------------------------

    public function testResolveRunnerHostReturnsHostContextWhenIdIsSet(): void
    {
        $hostContext = ['id' => 42, 'fqdn' => 'test.example.com'];
        $result = $this->svc->resolveRunnerHost($hostContext, null);
        $this->assertSame($hostContext, $result);
    }

    public function testResolveRunnerHostLoadsFromCanonicalSourceHostId(): void
    {
        $host = ['id' => 7, 'fqdn' => 'source.example.com'];
        $this->hosts->method('findById')->with(7)->willReturn($host);

        $canonicalPayload = ['source_host_id' => 7];
        $result = $this->svc->resolveRunnerHost(null, $canonicalPayload);
        $this->assertSame($host, $result);
    }

    public function testResolveRunnerHostFallsBackToFirstHostWhenSourceHostNotFound(): void
    {
        $this->hosts->method('findById')->willReturn(null);
        $firstHost = ['id' => 1, 'fqdn' => 'first.example.com'];
        $this->hosts->method('all')->willReturn([$firstHost]);

        $canonicalPayload = ['source_host_id' => 999];
        $result = $this->svc->resolveRunnerHost(null, $canonicalPayload);
        $this->assertSame($firstHost, $result);
    }

    public function testResolveRunnerHostFallsBackToFirstHostWhenNoCanonical(): void
    {
        $firstHost = ['id' => 1, 'fqdn' => 'first.example.com'];
        $this->hosts->method('all')->willReturn([$firstHost]);

        $result = $this->svc->resolveRunnerHost(null, null);
        $this->assertSame($firstHost, $result);
    }

    public function testResolveRunnerHostReturnsNullWhenNoHostsExist(): void
    {
        $this->hosts->method('all')->willReturn([]);
        $result = $this->svc->resolveRunnerHost(null, null);
        $this->assertNull($result);
    }

    public function testResolveRunnerHostIgnoresContextWithoutId(): void
    {
        $firstHost = ['id' => 1, 'fqdn' => 'first.example.com'];
        $this->hosts->method('all')->willReturn([$firstHost]);

        // hostContext exists but has no 'id' key
        $result = $this->svc->resolveRunnerHost(['fqdn' => 'no-id.example.com'], null);
        $this->assertSame($firstHost, $result);
    }

    public function testCanonicalAuthSnapshotResolvesCanonicalPayloadPointerAndValidatesIt(): void
    {
        $canonicalAuth = [
            'last_refresh' => self::VALID_LAST_REFRESH,
            'auths' => [
                'api.openai.com' => [
                    'token' => self::VALID_TOKEN,
                    'token_type' => 'bearer',
                ],
            ],
        ];
        $encoded = json_encode($canonicalAuth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        self::assertIsString($encoded);

        $this->versions->method('get')->willReturnCallback(static function (string $name): ?string {
            return $name === 'canonical_payload_id' ? '42' : null;
        });
        $this->payloads->expects(self::once())
            ->method('findByIdWithEntries')
            ->with(42)
            ->willReturn([
                'id' => 42,
                'last_refresh' => self::VALID_LAST_REFRESH,
                'sha256' => hash('sha256', $encoded),
                'source_host_id' => null,
                'body' => $encoded,
                'entries' => [],
            ]);
        $this->payloads->expects(self::never())->method('latest');

        $snapshot = $this->svc->canonicalAuthSnapshot();

        $this->assertSame($canonicalAuth, $snapshot);
    }

    public function testCanonicalAuthSnapshotReturnsNullForInvalidCanonicalPayload(): void
    {
        $canonicalAuth = [
            'last_refresh' => self::VALID_LAST_REFRESH,
            'auths' => [
                'api.openai.com' => [
                    'token' => self::VALID_TOKEN,
                    'token_type' => 'bearer',
                ],
            ],
        ];
        $encoded = json_encode($canonicalAuth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        self::assertIsString($encoded);

        $this->versions->method('get')->willReturnCallback(static function (string $name): ?string {
            return $name === 'canonical_payload_id' ? '42' : null;
        });
        $this->payloads->method('findByIdWithEntries')->willReturn([
            'id' => 42,
            'last_refresh' => self::VALID_LAST_REFRESH,
            'sha256' => str_repeat('0', 64),
            'source_host_id' => null,
            'body' => $encoded,
            'entries' => [],
        ]);
        $this->logs->expects(self::once())->method('log');

        $snapshot = $this->svc->canonicalAuthSnapshot();

        $this->assertNull($snapshot);
    }

    public function testTriggerRunnerRefreshAcceptsSystemOwnedCanonicalWithoutHost(): void
    {
        $canonicalAuth = [
            'last_refresh' => self::VALID_LAST_REFRESH,
            'auths' => [
                'api.openai.com' => [
                    'token' => self::VALID_TOKEN,
                    'token_type' => 'bearer',
                ],
            ],
        ];
        $encoded = json_encode($canonicalAuth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        self::assertIsString($encoded);
        $digest = hash('sha256', $encoded);

        $hosts = $this->getMockBuilder(HostRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $hosts->expects(self::never())->method('findById');
        $hosts->method('all')->willReturn([]);

        $payloads = $this->getMockBuilder(AuthPayloadRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $payloads->method('findByIdWithEntries')->willReturn([
            'id' => 42,
            'last_refresh' => self::VALID_LAST_REFRESH,
            'sha256' => $digest,
            'source_host_id' => null,
            'body' => $encoded,
            'entries' => [],
        ]);
        $payloads->expects(self::never())->method('create');

        $hostStates = $this->getMockBuilder(HostAuthStateRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $logs = $this->getMockBuilder(LogRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $versions = $this->getMockBuilder(VersionRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $versions->method('get')->willReturnCallback(static function (string $name): ?string {
            return match ($name) {
                'canonical_payload_id' => '42',
                'runner_last_check' => null,
                'runner_last_fail' => null,
                default => null,
            };
        });
        $versions->expects(self::atLeastOnce())->method('set');

        $runner = $this->createMock(RunnerVerifier::class);
        $runner->expects(self::once())
            ->method('verify')
            ->with($canonicalAuth, null, null, [])
            ->willReturn([
                'status' => 'ok',
                'reachable' => true,
                'latency_ms' => 5,
            ]);

        $svc = new RunnerValidationService(
            $hosts,
            $payloads,
            $hostStates,
            $logs,
            $versions,
            $runner
        );

        $result = $svc->triggerRunnerRefresh(static fn (): array => []);

        $this->assertFalse($result['applied']);
        $this->assertSame($digest, $result['canonical_digest']);
        $this->assertSame(self::VALID_LAST_REFRESH, $result['canonical_last_refresh']);
    }

    public function testRunDailyPreflightUsesShortTimeoutForBackgroundRunnerProbe(): void
    {
        $canonicalAuth = [
            'last_refresh' => self::VALID_LAST_REFRESH,
            'auths' => [
                'api.openai.com' => [
                    'token' => self::VALID_TOKEN,
                    'token_type' => 'bearer',
                ],
            ],
        ];
        $encoded = json_encode($canonicalAuth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        self::assertIsString($encoded);
        $digest = hash('sha256', $encoded);

        $hosts = $this->getMockBuilder(HostRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $hosts->method('all')->willReturn([]);

        $payloads = $this->getMockBuilder(AuthPayloadRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $payloads->method('findByIdWithEntries')->willReturn([
            'id' => 42,
            'last_refresh' => self::VALID_LAST_REFRESH,
            'sha256' => $digest,
            'source_host_id' => null,
            'body' => $encoded,
            'entries' => [],
        ]);
        $payloads->expects(self::never())->method('create');

        $hostStates = $this->getMockBuilder(HostAuthStateRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $logs = $this->getMockBuilder(LogRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $versions = $this->getMockBuilder(VersionRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $versions->method('get')->willReturnCallback(static function (string $name): ?string {
            return match ($name) {
                'canonical_payload_id' => '42',
                'daily_preflight' => null,
                'runner_last_check' => null,
                'runner_last_fail' => null,
                default => null,
            };
        });
        $versions->expects(self::atLeastOnce())->method('set');

        $runner = $this->createMock(RunnerVerifier::class);
        $runner->expects(self::once())
            ->method('verify')
            ->with($canonicalAuth, null, 2.0, [])
            ->willReturn([
                'status' => 'fail',
                'reachable' => false,
                'reason' => 'runner ping failed',
            ]);

        $svc = new RunnerValidationService(
            $hosts,
            $payloads,
            $hostStates,
            $logs,
            $versions,
            $runner
        );

        $refreshed = false;
        $svc->runDailyPreflight(null, static function (bool $force) use (&$refreshed): void {
            $refreshed = $force;
        }, static fn (): array => []);

        $this->assertTrue($refreshed);
    }
}
