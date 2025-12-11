<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Symfony\Component\Uid\Uuid;
use Webauthn\AuthenticatorAssertionResponseValidator;
use Webauthn\AuthenticatorAttestationResponseValidator;
use Webauthn\PublicKeyCredentialSource;
use Webauthn\TrustPath\EmptyTrustPath;

final class PasskeyServiceStaticTest extends TestCase
{
    public function testStoredCredentialRehydrationUsesArrayTransports(): void
    {
        $counter = 42;
        $source = PublicKeyCredentialSource::create(
            random_bytes(32),
            'public-key',
            [],                   // transports must be an array
            'none',
            new EmptyTrustPath(),
            Uuid::fromString('00000000-0000-0000-0000-000000000000'),
            random_bytes(64),
            random_bytes(32),
            $counter,
            null,
            null,
            null
        );

        $this->assertIsArray($source->getTransports());
        $this->assertSame('none', $source->getAttestationType());
        $this->assertSame($counter, $source->getCounter());
    }

    public function testValidatorSignaturesMatchExpectedArity(): void
    {
        $assertion = new ReflectionMethod(AuthenticatorAssertionResponseValidator::class, 'check');
        $attestation = new ReflectionMethod(AuthenticatorAttestationResponseValidator::class, 'check');

        $this->assertSame(
            ['credentialId', 'authenticatorAssertionResponse', 'publicKeyCredentialRequestOptions', 'request', 'userHandle', 'securedRelyingPartyId'],
            array_map(fn(ReflectionParameter $p) => $p->getName(), $assertion->getParameters())
        );

        $this->assertSame(
            ['authenticatorAttestationResponse', 'publicKeyCredentialCreationOptions', 'request', 'securedRelyingPartyId'],
            array_map(fn(ReflectionParameter $p) => $p->getName(), $attestation->getParameters())
        );
    }
}
