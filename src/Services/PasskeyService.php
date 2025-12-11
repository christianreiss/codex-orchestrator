<?php

declare(strict_types=1);

namespace App\Services;

use App\Repositories\AdminPasskeyRepository;
use App\Repositories\VersionRepository;
use Cose\Algorithm\Manager as CoseAlgorithmManager;
use Cose\Algorithm\Signature\ECDSA\ES256;
use Cose\Algorithm\Signature\RSA\RS256;
use DateInterval;
use DateTimeImmutable;
use Throwable;
use Symfony\Component\Uid\Uuid;
use Webauthn\AttestationStatement\AndroidKeyAttestationStatementSupport;
use Webauthn\AttestationStatement\AndroidSafetyNetAttestationStatementSupport;
use Webauthn\AttestationStatement\AppleAttestationStatementSupport;
use Webauthn\AttestationStatement\AttestationObjectLoader;
use Webauthn\AttestationStatement\AttestationStatementSupportManager;
use Webauthn\AttestationStatement\FidoU2FAttestationStatementSupport;
use Webauthn\AttestationStatement\PackedAttestationStatementSupport;
use Webauthn\AttestationStatement\TPMAttestationStatementSupport;
use Webauthn\AuthenticatorAssertionResponse;
use Webauthn\AuthenticatorAssertionResponseValidator;
use Webauthn\AuthenticatorAttestationResponse;
use Webauthn\AuthenticatorAttestationResponseValidator;
use Webauthn\AuthenticatorSelectionCriteria;
use Webauthn\PublicKeyCredentialUserEntity;
use Webauthn\PublicKeyCredentialCreationOptions;
use Webauthn\PublicKeyCredentialDescriptor;
use Webauthn\PublicKeyCredentialLoader;
use Webauthn\PublicKeyCredentialParameters;
use Webauthn\PublicKeyCredentialRequestOptions;
use Webauthn\PublicKeyCredentialRpEntity;
use Webauthn\PublicKeyCredentialSource;
use Webauthn\PublicKeyCredentialSourceRepository;
use Webauthn\TokenBinding\TokenBindingNotSupportedHandler;
use Webauthn\TrustPath\EmptyTrustPath;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Bridge\PsrHttpMessage\Factory\PsrHttpFactory;
use Nyholm\Psr7\Factory\Psr17Factory;

/**
 * One-admin passkey orchestration: issues WebAuthn options, verifies responses, stores single credential.
 */
class PasskeyService
{
    private const CHALLENGE_TTL_SECONDS = 300;
    private const VERSION_KEY_REGISTER = 'passkey_register_chal';
    private const VERSION_KEY_AUTH = 'passkey_auth_chal';

    public function __construct(
        private AdminPasskeyRepository $repo,
        private VersionRepository $versionRepository,
        private string $rpId,
        private string $rpName,
        /** @var string[] */
        private array $allowedOrigins = [],
    ) {
        if ($this->allowedOrigins === []) {
            // Default to both https and http for the host to keep local/dev dashboards working.
            $this->allowedOrigins = [
                'https://' . $this->rpId,
                'http://' . $this->rpId,
            ];
        }
    }

    public function registrationOptions(): PublicKeyCredentialCreationOptions
    {
        $userHandle = random_bytes(32);
        $challenge = random_bytes(32);

        $this->persistRegistrationContext($challenge, $userHandle);

        $rp = new PublicKeyCredentialRpEntity($this->rpName, $this->rpId, null);
        $user = new PublicKeyCredentialUserEntity('admin', $userHandle, 'admin');

        return PublicKeyCredentialCreationOptions::create(
            $rp,
            $user,
            $challenge,
            [
                new PublicKeyCredentialParameters('public-key', -7), // ES256
                new PublicKeyCredentialParameters('public-key', -257), // RS256
            ]
        )
            ->setAuthenticatorSelection(
                AuthenticatorSelectionCriteria::create()
                    ->setResidentKey(AuthenticatorSelectionCriteria::RESIDENT_KEY_REQUIREMENT_PREFERRED)
                    ->setUserVerification(AuthenticatorSelectionCriteria::USER_VERIFICATION_REQUIREMENT_REQUIRED)
            )
            ->setTimeout(60000);
    }

    public function finishRegistration(array $requestBody): array
    {
        $requestBody = $this->stripNulls($requestBody);
        $context = $this->pullRegistrationContext();
        if ($context === null) {
            throw new \RuntimeException('No registration challenge in flight or it expired');
        }
        $expectedChallenge = $context['challenge'];
        $userHandle = $context['user_handle'];

        $publicKeyCredential = $this->publicKeyCredentialLoader()->loadArray($requestBody);
        $response = $publicKeyCredential->getResponse();
        if (!$response instanceof AuthenticatorAttestationResponse) {
            throw new \RuntimeException('Invalid attestation response');
        }

        $creationOptions = $this->rebuildCreationOptions($userHandle, $expectedChallenge);
        $publicKeyCredentialSource = $this->attestationValidator()->check(
            $response,
            $creationOptions,
            $this->currentServerRequest(),
            [$this->rpId]
        );

        $this->repo->saveSingle(
            $publicKeyCredentialSource->getPublicKeyCredentialId(),
            $publicKeyCredentialSource->getCredentialPublicKey(),
            $publicKeyCredentialSource->getUserHandle(),
            $publicKeyCredentialSource->getCounter()
        );
        $this->versionRepository->set('passkey_created', '1');
        $this->versionRepository->set('passkey_auth', 'ok');
        $this->versionRepository->set('passkey_auth_at', (new DateTimeImmutable())->format(DATE_ATOM));

        return [
            'credential_id' => $this->b64urlEncode($publicKeyCredentialSource->getPublicKeyCredentialId()),
            'counter' => $publicKeyCredentialSource->getCounter(),
        ];
    }

    public function authOptions(): PublicKeyCredentialRequestOptions
    {
        $stored = $this->repo->findOne();
        if (!$stored) {
            throw new \RuntimeException('Passkey not created');
        }

        $challenge = random_bytes(32);
        $this->persistChallenge(self::VERSION_KEY_AUTH, $challenge);

        return PublicKeyCredentialRequestOptions::create(
            $challenge,
            $this->rpId,
            [
                new PublicKeyCredentialDescriptor(
                    'public-key',
                    $stored['credential_id']
                ),
            ],
            PublicKeyCredentialRequestOptions::USER_VERIFICATION_REQUIREMENT_REQUIRED,
            60000
        );
    }

    public function finishAuth(array $requestBody): array
    {
        $requestBody = $this->stripNulls($requestBody);
        $expectedChallenge = $this->pullChallenge(self::VERSION_KEY_AUTH);
        if ($expectedChallenge === null) {
            throw new \RuntimeException('No auth challenge in flight or it expired');
        }

        $stored = $this->repo->findOne();
        if (!$stored) {
            throw new \RuntimeException('Passkey not created');
        }

        $credentialRepo = new class($stored) implements PublicKeyCredentialSourceRepository {
            public function __construct(private array $stored)
            {
            }
            public function findOneByCredentialId(string $publicKeyCredentialId): ?\Webauthn\PublicKeyCredentialSource
            {
                if ($publicKeyCredentialId !== $this->stored['credential_id']) {
                    return null;
                }
                return \Webauthn\PublicKeyCredentialSource::create(
                    $publicKeyCredentialId,
                    'public-key',
                    [], // transports unknown; stored credential permits all
                    'none',
                    new EmptyTrustPath(),
                    Uuid::fromString('00000000-0000-0000-0000-000000000000'),
                    $this->stored['public_key'],
                    $this->stored['user_handle'],
                    (int) $this->stored['counter'],
                    null,
                    null,
                    null
                );
            }
            public function findAllForUserEntity(\Webauthn\PublicKeyCredentialUserEntity $userEntity): array
            {
                return [];
            }
            public function saveCredentialSource(\Webauthn\PublicKeyCredentialSource $publicKeyCredentialSource): void
            {
                // No-op: single credential is persisted via repository updateCounter.
            }
        };

        $publicKeyCredential = $this->publicKeyCredentialLoader()->loadArray($requestBody);
        $response = $publicKeyCredential->getResponse();
        if (!$response instanceof AuthenticatorAssertionResponse) {
            throw new \RuntimeException('Invalid assertion response');
        }

        $requestOptions = $this->rebuildRequestOptions($expectedChallenge, $stored['credential_id']);
        $validated = $this->assertionValidator($credentialRepo)->check(
            $publicKeyCredential->getRawId(),
            $response,
            $requestOptions,
            $this->currentServerRequest(),
            $stored['user_handle'],
            [$this->rpId]
        );

        $this->repo->updateCounter($stored['credential_id'], $validated->getCounter());
        $this->versionRepository->set('passkey_auth', 'ok');
        $this->versionRepository->set('passkey_auth_at', (new DateTimeImmutable())->format(DATE_ATOM));

        return [
            'counter' => $validated->getCounter(),
        ];
    }

    /**
     * Some browsers/clients send explicit nulls for optional WebAuthn fields; the Webauthn loader
     * treats the presence of a null attestationObject as fatal. Strip nulls recursively.
     */
    private function stripNulls(array $data): array
    {
        foreach ($data as $key => $value) {
            if ($value === null) {
                unset($data[$key]);
                continue;
            }
            if (is_array($value)) {
                $data[$key] = $this->stripNulls($value);
            }
        }
        return $data;
    }

    public function delete(): void
    {
        $this->repo->deleteAll();
        $this->versionRepository->delete('passkey_created');
        $this->versionRepository->delete('passkey_auth');
        $this->versionRepository->delete('passkey_auth_at');
    }

    private function persistChallenge(string $key, string $challenge): void
    {
        $expiresAt = (new DateTimeImmutable())->add(new DateInterval('PT' . self::CHALLENGE_TTL_SECONDS . 'S'))->format(DATE_ATOM);
        $this->versionRepository->set($key, json_encode([
            'challenge' => $this->b64urlEncode($challenge),
            'expires_at' => $expiresAt,
        ]));
    }

    private function persistRegistrationContext(string $challenge, string $userHandle): void
    {
        $expiresAt = (new DateTimeImmutable())->add(new DateInterval('PT' . self::CHALLENGE_TTL_SECONDS . 'S'))->format(DATE_ATOM);
        $this->versionRepository->set(self::VERSION_KEY_REGISTER, json_encode([
            'challenge' => $this->b64urlEncode($challenge),
            'user_handle' => $this->b64urlEncode($userHandle),
            'expires_at' => $expiresAt,
        ]));
    }

    private function currentRequest(): Request
    {
        // Only origin / host headers are needed for WebAuthn validation; avoid re-reading the body.
        return Request::createFromGlobals();
    }

    private function currentServerRequest(): \Psr\Http\Message\ServerRequestInterface
    {
        // Bridge Symfony Request to PSR-7 for web-authn validator signatures.
        $symfonyRequest = $this->currentRequest();
        $psr17Factory = new Psr17Factory();
        $psrHttpFactory = new PsrHttpFactory($psr17Factory, $psr17Factory, $psr17Factory, $psr17Factory);
        return $psrHttpFactory->createRequest($symfonyRequest);
    }

    private function pullChallenge(string $key): ?string
    {
        $raw = $this->versionRepository->get($key);
        if (!$raw) {
            return null;
        }
        $this->versionRepository->delete($key);
        try {
            $parsed = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
            $expires = isset($parsed['expires_at']) ? new DateTimeImmutable((string) $parsed['expires_at']) : null;
            if ($expires && $expires < new DateTimeImmutable()) {
                return null;
            }
            return $this->b64urlDecode($parsed['challenge']);
        } catch (Throwable) {
            return null;
        }
    }

    private function pullRegistrationContext(): ?array
    {
        $raw = $this->versionRepository->get(self::VERSION_KEY_REGISTER);
        if (!$raw) {
            return null;
        }
        $this->versionRepository->delete(self::VERSION_KEY_REGISTER);
        try {
            $parsed = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
            $expires = isset($parsed['expires_at']) ? new DateTimeImmutable((string) $parsed['expires_at']) : null;
            if ($expires && $expires < new DateTimeImmutable()) {
                return null;
            }
            if (!isset($parsed['challenge'], $parsed['user_handle'])) {
                throw new \RuntimeException('Registration context missing required fields');
            }
            return [
                'challenge' => $this->b64urlDecode($parsed['challenge']),
                'user_handle' => $this->b64urlDecode($parsed['user_handle']),
            ];
        } catch (Throwable) {
            return null;
        }
    }

    private function publicKeyCredentialLoader(): PublicKeyCredentialLoader
    {
        $attestationManager = $this->createAttestationSupportManager();
        $attestationLoader = AttestationObjectLoader::create($attestationManager);

        return PublicKeyCredentialLoader::create($attestationLoader);
    }

    private function createAttestationSupportManager(): AttestationStatementSupportManager
    {
        $algoManager = $this->createAlgorithmManager();

        // SafetyNet support requires web-token/jwt-library; avoid throwing if absent.
        $supports = [
            new PackedAttestationStatementSupport($algoManager),
            new FidoU2FAttestationStatementSupport(),
            new AndroidKeyAttestationStatementSupport(),
            new TPMAttestationStatementSupport(),
            new AppleAttestationStatementSupport(),
        ];

        if (class_exists(\Jose\Component\Signature\Algorithm\RS256::class)) {
            $supports[] = new AndroidSafetyNetAttestationStatementSupport();
        }

        return AttestationStatementSupportManager::create($supports);
    }

    private function createAlgorithmManager(): CoseAlgorithmManager
    {
        $manager = new CoseAlgorithmManager();
        $manager->add(new ES256());
        $manager->add(new RS256());
        return $manager;
    }

    private function attestationValidator(): AuthenticatorAttestationResponseValidator
    {
        return AuthenticatorAttestationResponseValidator::create(
            $this->createAttestationSupportManager(),
            null,
            TokenBindingNotSupportedHandler::create()
        );
    }

    private function assertionValidator(PublicKeyCredentialSourceRepository $credentialRepo): AuthenticatorAssertionResponseValidator
    {
        $algorithmManager = $this->createAlgorithmManager();

        return AuthenticatorAssertionResponseValidator::create(
            $credentialRepo,
            TokenBindingNotSupportedHandler::create(),
            null,
            $algorithmManager
        );
    }

    private function rebuildCreationOptions(string $userHandle, string $challenge): PublicKeyCredentialCreationOptions
    {
        $rp = new PublicKeyCredentialRpEntity($this->rpName, $this->rpId, null);
        $user = new PublicKeyCredentialUserEntity('admin', $userHandle, 'admin');

        return PublicKeyCredentialCreationOptions::create(
            $rp,
            $user,
            $challenge,
            [
                new PublicKeyCredentialParameters('public-key', -7), // ES256
                new PublicKeyCredentialParameters('public-key', -257), // RS256
            ]
        )
            ->setAuthenticatorSelection(
                AuthenticatorSelectionCriteria::create()
                    ->setResidentKey(AuthenticatorSelectionCriteria::RESIDENT_KEY_REQUIREMENT_PREFERRED)
                    ->setUserVerification(AuthenticatorSelectionCriteria::USER_VERIFICATION_REQUIREMENT_REQUIRED)
            )
            ->setTimeout(60000);
    }

    private function rebuildRequestOptions(string $challenge, string $credentialId): PublicKeyCredentialRequestOptions
    {
        return PublicKeyCredentialRequestOptions::create(
            $challenge,
            $this->rpId,
            [
                new PublicKeyCredentialDescriptor(
                    'public-key',
                    $credentialId
                ),
            ],
            PublicKeyCredentialRequestOptions::USER_VERIFICATION_REQUIREMENT_REQUIRED,
            60000
        );
    }

    private function b64urlEncode(string $binary): string
    {
        return rtrim(strtr(base64_encode($binary), '+/', '-_'), '=');
    }

    private function b64urlDecode(string $value): string
    {
        $padded = str_replace(['-', '_'], ['+', '/'], $value);
        $pad = strlen($padded) % 4;
        if ($pad > 0) {
            $padded .= str_repeat('=', 4 - $pad);
        }
        $decoded = base64_decode($padded, true);
        if ($decoded === false) {
            throw new \RuntimeException('Invalid base64url string');
        }
        return $decoded;
    }
}
