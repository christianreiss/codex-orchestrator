<?php

declare(strict_types=1);

namespace App\Services;

use App\Repositories\AdminPasskeyRepository;
use App\Repositories\VersionRepository;
use DateInterval;
use DateTimeImmutable;
use Throwable;
use Webauthn\AuthenticatorAssertionResponse;
use Webauthn\AuthenticatorAttestationResponse;
use Webauthn\AuthenticatorSelectionCriteria;
use Webauthn\CredentialRepository;
use Webauthn\PublicKeyCredentialCreationOptions;
use Webauthn\PublicKeyCredentialDescriptor;
use Webauthn\PublicKeyCredentialParameters;
use Webauthn\PublicKeyCredentialRequestOptions;
use Webauthn\PublicKeyCredentialRpEntity;
use Webauthn\PublicKeyCredentialUserEntity;
use Webauthn\TokenBinding\TokenBindingNotSupportedHandler;
use Webauthn\Webauthn;

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
    ) {
    }

    public function registrationOptions(): PublicKeyCredentialCreationOptions
    {
        $userHandle = random_bytes(32);
        $challenge = random_bytes(32);

        $this->persistChallenge(self::VERSION_KEY_REGISTER, $challenge);

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
        $expectedChallenge = $this->pullChallenge(self::VERSION_KEY_REGISTER);
        if ($expectedChallenge === null) {
            throw new \RuntimeException('No registration challenge in flight or it expired');
        }

        $publicKeyCredential = \Webauthn\PublicKeyCredentialLoader::create()->loadArray($requestBody);
        $response = $publicKeyCredential->getResponse();
        if (!$response instanceof AuthenticatorAttestationResponse) {
            throw new \RuntimeException('Invalid attestation response');
        }

        $publicKeyCredentialSource = Webauthn::factory()
            ->validateAttestation(
                $publicKeyCredential->getRawId(),
                $publicKeyCredential->getType(),
                $response,
                $expectedChallenge,
                $this->rpId,
                ['https://' . $this->rpId],
                TokenBindingNotSupportedHandler::create()
            );

        $this->repo->saveSingle(
            $publicKeyCredentialSource->getPublicKeyCredentialId(),
            $publicKeyCredentialSource->getCredentialPublicKey(),
            $publicKeyCredentialSource->getUserHandle(),
            $publicKeyCredentialSource->getCounter()
        );
        $this->versionRepository->set('passkey_created', '1');
        $this->versionRepository->set('passkey_auth', 'ok');

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
            $challenge
        )
            ->setRpId($this->rpId)
            ->setAllowCredentials([
                new PublicKeyCredentialDescriptor(
                    'public-key',
                    $stored['credential_id']
                ),
            ])
            ->setUserVerification(PublicKeyCredentialRequestOptions::USER_VERIFICATION_REQUIREMENT_REQUIRED)
            ->setTimeout(60000);
    }

    public function finishAuth(array $requestBody): array
    {
        $expectedChallenge = $this->pullChallenge(self::VERSION_KEY_AUTH);
        if ($expectedChallenge === null) {
            throw new \RuntimeException('No auth challenge in flight or it expired');
        }

        $stored = $this->repo->findOne();
        if (!$stored) {
            throw new \RuntimeException('Passkey not created');
        }

        $credentialRepo = new class($stored) implements CredentialRepository {
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
                    $this->stored['public_key'],
                    $this->stored['user_handle'],
                    [],
                    null,
                    [],
                    (int) $this->stored['counter']
                );
            }
            public function findAllForUserEntity(\Webauthn\PublicKeyCredentialUserEntity $userEntity): array
            {
                return [];
            }
        };

        $publicKeyCredential = \Webauthn\PublicKeyCredentialLoader::create()->loadArray($requestBody);
        $response = $publicKeyCredential->getResponse();
        if (!$response instanceof AuthenticatorAssertionResponse) {
            throw new \RuntimeException('Invalid assertion response');
        }

        $validated = Webauthn::factory()->validateAssertion(
            $publicKeyCredential->getRawId(),
            $publicKeyCredential->getType(),
            $response,
            $expectedChallenge,
            $this->rpId,
            ['https://' . $this->rpId],
            $credentialRepo,
            TokenBindingNotSupportedHandler::create()
        );

        $this->repo->updateCounter($stored['credential_id'], $validated->getPublicKeyCredentialSource()->getCounter());
        $this->versionRepository->set('passkey_auth', 'ok');

        return [
            'counter' => $validated->getPublicKeyCredentialSource()->getCounter(),
        ];
    }

    public function delete(): void
    {
        $this->repo->deleteAll();
        $this->versionRepository->delete('passkey_created');
        $this->versionRepository->delete('passkey_auth');
    }

    private function persistChallenge(string $key, string $challenge): void
    {
        $expiresAt = (new DateTimeImmutable())->add(new DateInterval('PT' . self::CHALLENGE_TTL_SECONDS . 'S'))->format(DATE_ATOM);
        $this->versionRepository->set($key, json_encode([
            'challenge' => $this->b64urlEncode($challenge),
            'expires_at' => $expiresAt,
        ]));
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
