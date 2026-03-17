<?php

declare(strict_types=1);

use App\Database;
use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\AdminPasskeyRepository;
use App\Repositories\AdminUserRepository;
use App\Repositories\AdminWebAuthnChallengeRepository;
use App\Repositories\LogRepository;
use App\Services\AdminPasskeyService;
use App\Support\WebAuthnHelper;
use CBOR\ByteStringObject;
use CBOR\MapObject;
use CBOR\NegativeIntegerObject;
use CBOR\TextStringObject;
use CBOR\UnsignedIntegerObject;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminPasskeyServiceTest extends TestCase
{
    private PDO $pdo;
    private AdminPasskeyService $service;
    private AdminPasskeyRepository $passkeys;
    private AdminWebAuthnChallengeRepository $challenges;
    private AdminUserRepository $users;
    private AdminPasskeyTestLogRepository $logs;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

        $this->pdo->exec(
            'CREATE TABLE admin_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                username TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                access_level TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                last_login_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );
        $this->pdo->exec(
            'CREATE TABLE admin_passkeys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                credential_id BLOB NOT NULL,
                credential_id_hash TEXT NOT NULL UNIQUE,
                public_key_pem TEXT NOT NULL,
                cose_alg INTEGER NOT NULL,
                sign_count INTEGER NOT NULL DEFAULT 0,
                name TEXT NOT NULL DEFAULT \'\',
                transports TEXT NULL,
                aaguid TEXT NULL,
                created_at TEXT NOT NULL,
                last_used_at TEXT NULL
            )'
        );
        $this->pdo->exec(
            'CREATE TABLE admin_webauthn_challenges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                challenge TEXT NOT NULL UNIQUE,
                user_id INTEGER NULL,
                type TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $this->users = new AdminUserRepository($database);
        $this->passkeys = new AdminPasskeyRepository($database);
        $this->challenges = new AdminWebAuthnChallengeRepository($database);
        $this->logs = new AdminPasskeyTestLogRepository();

        $this->service = new AdminPasskeyService(
            $this->passkeys,
            $this->challenges,
            $this->users,
            $this->logs
        );

        $this->users->create([
            'name' => 'Admin',
            'username' => 'admin',
            'email' => 'admin@example.com',
            'password_hash' => password_hash('test', PASSWORD_DEFAULT),
            'access_level' => 'admin',
            'active' => true,
        ]);
        $this->users->create([
            'name' => 'Disabled',
            'username' => 'disabled',
            'email' => 'disabled@example.com',
            'password_hash' => password_hash('test', PASSWORD_DEFAULT),
            'access_level' => 'admin',
            'active' => false,
        ]);
    }

    public function testBeginRegistrationReturnsHardenedOptions(): void
    {
        $user = $this->adminUser();
        $options = $this->service->beginRegistration($user, 'example.com', 'Test RP');

        self::assertNotEmpty($options['challenge']);
        self::assertSame(64, strlen($options['challenge']));
        self::assertSame('example.com', $options['rp']['id']);
        self::assertSame('Test RP', $options['rp']['name']);
        self::assertSame('admin', $options['user']['name']);
        self::assertCount(2, $options['pubKeyCredParams']);
        self::assertSame('none', $options['attestation']);
        self::assertSame('discouraged', $options['authenticatorSelection']['residentKey']);
        self::assertSame('required', $options['authenticatorSelection']['userVerification']);
        self::assertArrayNotHasKey('authenticatorAttachment', $options['authenticatorSelection']);
        self::assertIsArray($options['excludeCredentials']);
    }

    public function testBeginRegistrationCreatesChallenge(): void
    {
        $user = $this->adminUser();
        $options = $this->service->beginRegistration($user, 'example.com', 'Test RP');

        $challenge = $this->challenges->consume($options['challenge'], gmdate(DATE_ATOM));
        self::assertNotNull($challenge);
        self::assertSame('registration', $challenge['type']);
        self::assertSame((string) $user['id'], (string) $challenge['user_id']);
    }

    public function testBeginAuthenticationReturnsUserBoundOptions(): void
    {
        $user = $this->adminUser();
        $credentialId = random_bytes(32);
        $this->passkeys->create(
            (int) $user['id'],
            $credentialId,
            hash('sha256', $credentialId),
            'dummy-pem',
            WebAuthnHelper::COSE_ALG_ES256,
            0,
            'Test Key',
            'internal',
            null
        );

        $options = $this->service->beginAuthentication('admin', 'example.com');

        self::assertNotEmpty($options['challenge']);
        self::assertSame('example.com', $options['rpId']);
        self::assertSame(300000, $options['timeout']);
        self::assertSame('required', $options['userVerification']);
        self::assertCount(1, $options['allowCredentials']);
        self::assertSame(bin2hex($credentialId), $options['allowCredentials'][0]['id']);
        self::assertSame(['internal'], $options['allowCredentials'][0]['transports']);

        $challenge = $this->challenges->consume($options['challenge'], gmdate(DATE_ATOM));
        self::assertNotNull($challenge);
        self::assertSame('authentication', $challenge['type']);
        self::assertSame((string) $user['id'], (string) $challenge['user_id']);
    }

    public function testBeginAuthenticationRejectsMissingUsername(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->beginAuthentication('', 'example.com');
    }

    public function testBeginAuthenticationRejectsUnknownOrInactiveUser(): void
    {
        $this->expectException(HttpException::class);
        $this->service->beginAuthentication('disabled', 'example.com');
    }

    public function testBeginAuthenticationRejectsUserWithoutPasskeys(): void
    {
        $this->expectException(HttpException::class);
        $this->service->beginAuthentication('admin', 'example.com');
    }

    public function testCompleteRegistrationStoresCredentialWhenUvIsPresent(): void
    {
        $user = $this->adminUser();
        $options = $this->service->beginRegistration($user, 'example.com', 'Test RP');
        $credential = $this->generateEcCredential();
        $payload = $this->buildRegistrationPayload(
            $options['challenge'],
            'https://example.com',
            'example.com',
            $credential,
            true
        );

        $result = $this->service->completeRegistration($user, $payload, 'example.com', 'https://example.com');

        self::assertSame('Laptop key', $result['name']);
        $rows = $this->passkeys->findAllForUser((int) $user['id']);
        self::assertCount(1, $rows);
        self::assertSame(0, (int) $rows[0]['sign_count']);
        self::assertSame('usb,internal', $rows[0]['transports']);
        self::assertSame('admin.passkey.register', $this->logs->entries[0]['action'] ?? null);
    }

    public function testCompleteRegistrationRejectsMissingUvFlag(): void
    {
        $user = $this->adminUser();
        $options = $this->service->beginRegistration($user, 'example.com', 'Test RP');
        $credential = $this->generateEcCredential();
        $payload = $this->buildRegistrationPayload(
            $options['challenge'],
            'https://example.com',
            'example.com',
            $credential,
            false
        );

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('User verification flag not set');
        $this->service->completeRegistration($user, $payload, 'example.com', 'https://example.com');
    }

    public function testCompleteAuthenticationAcceptsValidAssertionAndUpdatesSignCount(): void
    {
        $user = $this->adminUser();
        $credential = $this->createStoredCredentialForUser((int) $user['id'], 'My Key', 1);
        $options = $this->service->beginAuthentication('admin', 'example.com');
        $payload = $this->buildAuthenticationPayload(
            $options['challenge'],
            'https://example.com',
            'example.com',
            $credential['credential_id'],
            $credential['private_key'],
            5,
            pack('N', (int) $user['id']),
            true
        );

        $result = $this->service->completeAuthentication($payload, 'example.com', 'https://example.com');

        self::assertSame('admin', $result['username']);
        $stored = $this->passkeys->findByCredentialIdHash(hash('sha256', $credential['credential_id']));
        self::assertNotNull($stored);
        self::assertSame(5, (int) $stored['sign_count']);
        self::assertNotNull($stored['last_used_at']);
        self::assertSame('admin.auth.passkey.login', $this->logs->entries[0]['action'] ?? null);
    }

    public function testCompleteAuthenticationAcceptsDerEncodedBrowserAssertionSignature(): void
    {
        $user = $this->adminUser();
        $credential = $this->createStoredCredentialForUser((int) $user['id'], 'My Key', 1);
        $options = $this->service->beginAuthentication('admin', 'example.com');
        $payload = $this->buildAuthenticationPayload(
            $options['challenge'],
            'https://example.com',
            'example.com',
            $credential['credential_id'],
            $credential['private_key'],
            5,
            pack('N', (int) $user['id']),
            true,
            false
        );

        $result = $this->service->completeAuthentication($payload, 'example.com', 'https://example.com');

        self::assertSame('admin', $result['username']);
        $stored = $this->passkeys->findByCredentialIdHash(hash('sha256', $credential['credential_id']));
        self::assertNotNull($stored);
        self::assertSame(5, (int) $stored['sign_count']);
        self::assertNotNull($stored['last_used_at']);
    }

    public function testCompleteAuthenticationRejectsMissingUvFlag(): void
    {
        $user = $this->adminUser();
        $credential = $this->createStoredCredentialForUser((int) $user['id'], 'My Key', 1);
        $options = $this->service->beginAuthentication('admin', 'example.com');
        $payload = $this->buildAuthenticationPayload(
            $options['challenge'],
            'https://example.com',
            'example.com',
            $credential['credential_id'],
            $credential['private_key'],
            2,
            null,
            false
        );

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('User verification flag not set');
        $this->service->completeAuthentication($payload, 'example.com', 'https://example.com');
    }

    public function testCompleteAuthenticationKeepsStoredCounterOnRegressionAndLogsIt(): void
    {
        $user = $this->adminUser();
        $credential = $this->createStoredCredentialForUser((int) $user['id'], 'My Key', 10);
        $options = $this->service->beginAuthentication('admin', 'example.com');
        $payload = $this->buildAuthenticationPayload(
            $options['challenge'],
            'https://example.com',
            'example.com',
            $credential['credential_id'],
            $credential['private_key'],
            9,
            null,
            true
        );

        $result = $this->service->completeAuthentication($payload, 'example.com', 'https://example.com');

        self::assertSame('admin', $result['username']);
        $stored = $this->passkeys->findByCredentialIdHash(hash('sha256', $credential['credential_id']));
        self::assertNotNull($stored);
        self::assertSame(10, (int) $stored['sign_count']);
        self::assertNotNull($stored['last_used_at']);
        self::assertSame('admin.auth.passkey.sign_count_regression', $this->logs->entries[0]['action'] ?? null);
        self::assertSame('admin.auth.passkey.login', $this->logs->entries[1]['action'] ?? null);
    }

    public function testCompleteAuthenticationRejectsInvalidBase64urlPayloadAsHttpException(): void
    {
        $user = $this->adminUser();
        $credential = $this->createStoredCredentialForUser((int) $user['id'], 'My Key', 1);
        $options = $this->service->beginAuthentication('admin', 'example.com');
        $payload = $this->buildAuthenticationPayload(
            $options['challenge'],
            'https://example.com',
            'example.com',
            $credential['credential_id'],
            $credential['private_key'],
            2,
            null,
            true
        );

        $payload['response']['signature'] = '%%%not-base64url%%%';

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('Invalid response.signature');
        $this->service->completeAuthentication($payload, 'example.com', 'https://example.com');
    }

    public function testCompleteAuthenticationRejectsMalformedAuthenticatorDataAsHttpException(): void
    {
        $user = $this->adminUser();
        $credential = $this->createStoredCredentialForUser((int) $user['id'], 'My Key', 1);
        $options = $this->service->beginAuthentication('admin', 'example.com');
        $payload = $this->buildAuthenticationPayload(
            $options['challenge'],
            'https://example.com',
            'example.com',
            $credential['credential_id'],
            $credential['private_key'],
            2,
            null,
            true
        );

        $payload['response']['authenticatorData'] = WebAuthnHelper::base64urlEncode('short');

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('Authenticator data too short');
        $this->service->completeAuthentication($payload, 'example.com', 'https://example.com');
    }

    public function testListForUserEmpty(): void
    {
        $list = $this->service->listForUser((int) $this->adminUser()['id']);
        self::assertSame([], $list);
    }

    public function testDeletePasskeyNotFound(): void
    {
        $this->expectException(HttpException::class);
        $this->service->deletePasskey(999, 1);
    }

    public function testDeletePasskeyWrongUser(): void
    {
        $credId = random_bytes(32);
        $this->passkeys->create(
            1,
            $credId,
            hash('sha256', $credId),
            'dummy-pem',
            -7,
            0,
            'Test Key',
            null,
            null
        );

        $list = $this->passkeys->findAllForUser(1);
        self::assertCount(1, $list);

        $this->expectException(HttpException::class);
        $this->service->deletePasskey((int) $list[0]['id'], 999);
    }

    public function testDeletePasskeySuccess(): void
    {
        $credId = random_bytes(32);
        $this->passkeys->create(
            1,
            $credId,
            hash('sha256', $credId),
            'dummy-pem',
            -7,
            0,
            'Test Key',
            null,
            null
        );

        $list = $this->passkeys->findAllForUser(1);
        self::assertCount(1, $list);

        $this->service->deletePasskey((int) $list[0]['id'], 1);
        self::assertCount(0, $this->passkeys->findAllForUser(1));
    }

    public function testUpdatePasskeyName(): void
    {
        $credId = random_bytes(32);
        $this->passkeys->create(
            1,
            $credId,
            hash('sha256', $credId),
            'dummy-pem',
            -7,
            0,
            'Old Name',
            null,
            null
        );

        $list = $this->passkeys->findAllForUser(1);
        $this->service->updatePasskeyName((int) $list[0]['id'], 1, 'New Name');

        $updated = $this->passkeys->findAllForUser(1);
        self::assertSame('New Name', $updated[0]['name']);
    }

    public function testUpdatePasskeyNameWrongUser(): void
    {
        $credId = random_bytes(32);
        $this->passkeys->create(1, $credId, hash('sha256', $credId), 'pem', -7, 0, 'X', null, null);
        $list = $this->passkeys->findAllForUser(1);

        $this->expectException(HttpException::class);
        $this->service->updatePasskeyName((int) $list[0]['id'], 999, 'Hack');
    }

    public function testChallengeExpiry(): void
    {
        $expired = gmdate(DATE_ATOM, time() - 10);
        $this->challenges->create('deadbeef' . str_repeat('0', 56), null, 'authentication', $expired);

        $result = $this->challenges->consume('deadbeef' . str_repeat('0', 56), gmdate(DATE_ATOM));
        self::assertNull($result);
    }

    public function testChallengeSingleUse(): void
    {
        $expiresAt = gmdate(DATE_ATOM, time() + 300);
        $challenge = bin2hex(random_bytes(32));
        $this->challenges->create($challenge, null, 'authentication', $expiresAt);

        $first = $this->challenges->consume($challenge, gmdate(DATE_ATOM));
        self::assertNotNull($first);

        $second = $this->challenges->consume($challenge, gmdate(DATE_ATOM));
        self::assertNull($second);
    }

    public function testListForUserSanitized(): void
    {
        $credId = random_bytes(32);
        $this->passkeys->create(1, $credId, hash('sha256', $credId), 'secret-pem-data', -7, 0, 'MyKey', 'internal', null);

        $list = $this->service->listForUser(1);
        self::assertCount(1, $list);
        self::assertSame('MyKey', $list[0]['name']);
        self::assertArrayNotHasKey('public_key_pem', $list[0]);
        self::assertArrayNotHasKey('credential_id', $list[0]);
        self::assertArrayNotHasKey('credential_id_hash', $list[0]);
    }

    private function adminUser(): array
    {
        $user = $this->users->findByUsername('admin');
        self::assertIsArray($user);
        return $user;
    }

    private function createStoredCredentialForUser(int $userId, string $name, int $signCount): array
    {
        $credential = $this->generateEcCredential();
        $this->passkeys->create(
            $userId,
            $credential['credential_id'],
            hash('sha256', $credential['credential_id']),
            WebAuthnHelper::coseKeyToPem($credential['cose_key'], WebAuthnHelper::COSE_ALG_ES256),
            WebAuthnHelper::COSE_ALG_ES256,
            $signCount,
            $name,
            'internal',
            '00000000-0000-0000-0000-000000000000'
        );

        return $credential;
    }

    private function generateEcCredential(): array
    {
        $privateKey = openssl_pkey_new([
            'curve_name' => 'prime256v1',
            'private_key_type' => OPENSSL_KEYTYPE_EC,
        ]);
        self::assertNotFalse($privateKey);

        $details = openssl_pkey_get_details($privateKey);
        self::assertIsArray($details);

        $x = str_pad((string) $details['ec']['x'], 32, "\x00", STR_PAD_LEFT);
        $y = str_pad((string) $details['ec']['y'], 32, "\x00", STR_PAD_LEFT);

        return [
            'private_key' => $privateKey,
            'credential_id' => random_bytes(32),
            'cose_key' => [
                1 => 2,
                3 => WebAuthnHelper::COSE_ALG_ES256,
                -1 => 1,
                -2 => $x,
                -3 => $y,
            ],
        ];
    }

    private function buildRegistrationPayload(
        string $challengeHex,
        string $origin,
        string $rpId,
        array $credential,
        bool $includeUv
    ): array {
        $flags = 0x01 | 0x40;
        if ($includeUv) {
            $flags |= 0x04;
        }

        $authData = hash('sha256', $rpId, true)
            . chr($flags)
            . pack('N', 0)
            . str_repeat("\x00", 16)
            . pack('n', strlen((string) $credential['credential_id']))
            . (string) $credential['credential_id']
            . $this->encodeCoseKey($credential['cose_key']);

        $attestation = MapObject::create()
            ->add(TextStringObject::create('fmt'), TextStringObject::create('none'))
            ->add(TextStringObject::create('authData'), ByteStringObject::create($authData))
            ->add(TextStringObject::create('attStmt'), MapObject::create());

        $clientDataJSON = json_encode([
            'type' => 'webauthn.create',
            'challenge' => WebAuthnHelper::base64urlEncode(hex2bin($challengeHex) ?: ''),
            'origin' => $origin,
        ], JSON_UNESCAPED_SLASHES);
        self::assertIsString($clientDataJSON);

        return [
            'rawId' => WebAuthnHelper::base64urlEncode((string) $credential['credential_id']),
            'name' => 'Laptop key',
            'response' => [
                'attestationObject' => WebAuthnHelper::base64urlEncode((string) $attestation),
                'clientDataJSON' => WebAuthnHelper::base64urlEncode($clientDataJSON),
                'transports' => ['usb', 'internal', 'bogus'],
            ],
        ];
    }

    private function buildAuthenticationPayload(
        string $challengeHex,
        string $origin,
        string $rpId,
        string $credentialId,
        mixed $privateKey,
        int $signCount,
        ?string $userHandle,
        bool $includeUv,
        bool $convertDerToP1363 = true
    ): array {
        $flags = 0x01;
        if ($includeUv) {
            $flags |= 0x04;
        }

        $authenticatorData = hash('sha256', $rpId, true)
            . chr($flags)
            . pack('N', $signCount);

        $clientDataJSON = json_encode([
            'type' => 'webauthn.get',
            'challenge' => WebAuthnHelper::base64urlEncode(hex2bin($challengeHex) ?: ''),
            'origin' => $origin,
        ], JSON_UNESCAPED_SLASHES);
        self::assertIsString($clientDataJSON);

        $signedData = $authenticatorData . hash('sha256', $clientDataJSON, true);
        $derSignature = '';
        $signed = openssl_sign($signedData, $derSignature, $privateKey, OPENSSL_ALGO_SHA256);
        self::assertTrue($signed);

        return [
            'rawId' => WebAuthnHelper::base64urlEncode($credentialId),
            'response' => [
                'authenticatorData' => WebAuthnHelper::base64urlEncode($authenticatorData),
                'clientDataJSON' => WebAuthnHelper::base64urlEncode($clientDataJSON),
                'signature' => WebAuthnHelper::base64urlEncode(
                    $convertDerToP1363 ? self::derToP1363($derSignature, 32) : $derSignature
                ),
                'userHandle' => $userHandle !== null ? WebAuthnHelper::base64urlEncode($userHandle) : null,
            ],
        ];
    }

    private function encodeCoseKey(array $coseKey): string
    {
        return (string) MapObject::create()
            ->add(UnsignedIntegerObject::create(1), UnsignedIntegerObject::create((int) $coseKey[1]))
            ->add(UnsignedIntegerObject::create(3), NegativeIntegerObject::create((int) $coseKey[3]))
            ->add(NegativeIntegerObject::create(-1), UnsignedIntegerObject::create((int) $coseKey[-1]))
            ->add(NegativeIntegerObject::create(-2), ByteStringObject::create((string) $coseKey[-2]))
            ->add(NegativeIntegerObject::create(-3), ByteStringObject::create((string) $coseKey[-3]));
    }

    private static function derToP1363(string $der, int $componentLength): string
    {
        $offset = 2;
        if (ord($der[$offset]) !== 0x02) {
            throw new RuntimeException('Invalid DER signature');
        }
        $offset++;
        $rLen = ord($der[$offset]);
        $offset++;
        $r = substr($der, $offset, $rLen);
        $offset += $rLen;

        if (ord($der[$offset]) !== 0x02) {
            throw new RuntimeException('Invalid DER signature');
        }
        $offset++;
        $sLen = ord($der[$offset]);
        $offset++;
        $s = substr($der, $offset, $sLen);

        $r = str_pad(ltrim($r, "\x00"), $componentLength, "\x00", STR_PAD_LEFT);
        $s = str_pad(ltrim($s, "\x00"), $componentLength, "\x00", STR_PAD_LEFT);

        return $r . $s;
    }

    private function fakeDatabase(PDO $pdo): Database
    {
        $reflection = new ReflectionClass(Database::class);
        /** @var Database $database */
        $database = $reflection->newInstanceWithoutConstructor();

        $pdoProperty = $reflection->getProperty('pdo');
        $pdoProperty->setAccessible(true);
        $pdoProperty->setValue($database, $pdo);

        $nameProperty = $reflection->getProperty('databaseName');
        $nameProperty->setAccessible(true);
        $nameProperty->setValue($database, 'sqlite');

        return $database;
    }
}

final class AdminPasskeyTestLogRepository extends LogRepository
{
    public array $entries = [];

    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        $this->entries[] = [
            'host_id' => $hostId,
            'action' => $action,
            'details' => $details,
        ];
    }
}
