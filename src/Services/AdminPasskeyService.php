<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\AdminPasskeyRepository;
use App\Repositories\AdminUserRepository;
use App\Repositories\AdminWebAuthnChallengeRepository;
use App\Repositories\LogRepository;
use App\Support\WebAuthnHelper;

class AdminPasskeyService
{
    private const CHALLENGE_TTL_SECONDS = 300;
    private const MAX_PASSKEYS_PER_USER = 10;

    public function __construct(
        private readonly AdminPasskeyRepository $passkeys,
        private readonly AdminWebAuthnChallengeRepository $challenges,
        private readonly AdminUserRepository $users,
        private readonly LogRepository $logs
    ) {
    }

    public function beginRegistration(array $user, string $rpId, string $rpName): array
    {
        $userId = (int) ($user['id'] ?? 0);
        $username = (string) ($user['username'] ?? '');
        $displayName = (string) ($user['name'] ?? $username);

        if ($userId === 0 || $username === '') {
            throw new HttpException('Invalid user', 400);
        }

        if ($this->passkeys->countForUser($userId) >= self::MAX_PASSKEYS_PER_USER) {
            throw new HttpException('Maximum number of passkeys reached', 400);
        }

        // Purge stale challenges opportunistically.
        $this->challenges->purgeExpired(gmdate(DATE_ATOM));

        $challenge = bin2hex(random_bytes(32));
        $expiresAt = gmdate(DATE_ATOM, time() + self::CHALLENGE_TTL_SECONDS);
        $this->challenges->create($challenge, $userId, 'registration', $expiresAt);

        // Build excludeCredentials from existing passkeys.
        $existing = $this->passkeys->findAllForUser($userId);
        $excludeCredentials = [];
        foreach ($existing as $cred) {
            $entry = [
                'type' => 'public-key',
                'id' => WebAuthnHelper::base64urlEncode((string) $cred['credential_id']),
            ];
            if (!empty($cred['transports'])) {
                $entry['transports'] = explode(',', (string) $cred['transports']);
            }
            $excludeCredentials[] = $entry;
        }

        // User handle: 4-byte big-endian packed user ID.
        $userHandle = WebAuthnHelper::base64urlEncode(pack('N', $userId));

        return [
            'challenge' => $challenge,
            'rp' => [
                'id' => $rpId,
                'name' => $rpName,
            ],
            'user' => [
                'id' => $userHandle,
                'name' => $username,
                'displayName' => $displayName,
            ],
            'pubKeyCredParams' => [
                ['type' => 'public-key', 'alg' => WebAuthnHelper::COSE_ALG_ES256],
                ['type' => 'public-key', 'alg' => WebAuthnHelper::COSE_ALG_RS256],
            ],
            'timeout' => 300000,
            'attestation' => 'none',
            'authenticatorSelection' => [
                'authenticatorAttachment' => 'platform',
                'residentKey' => 'preferred',
                'userVerification' => 'preferred',
            ],
            'excludeCredentials' => $excludeCredentials,
        ];
    }

    public function completeRegistration(array $user, array $payload, string $rpId, string $origin): array
    {
        $userId = (int) ($user['id'] ?? 0);
        if ($userId === 0) {
            throw new HttpException('Invalid user', 400);
        }

        $rawId = $this->requireBase64url($payload, 'rawId');
        $response = $payload['response'] ?? null;
        if (!is_array($response)) {
            throw new ValidationException(['response' => 'Missing attestation response']);
        }

        $clientDataJSON = WebAuthnHelper::base64urlDecode((string) ($response['clientDataJSON'] ?? ''));
        $attestationObjectBytes = WebAuthnHelper::base64urlDecode((string) ($response['attestationObject'] ?? ''));
        $transports = $response['transports'] ?? null;

        if ($clientDataJSON === '' || $attestationObjectBytes === '') {
            throw new ValidationException(['response' => 'Incomplete attestation response']);
        }

        // Parse and validate clientDataJSON.
        $clientData = json_decode($clientDataJSON, true);
        if (!is_array($clientData)) {
            throw new HttpException('Invalid clientDataJSON', 400);
        }

        if (($clientData['type'] ?? '') !== 'webauthn.create') {
            throw new HttpException('Invalid clientDataJSON type', 400);
        }

        // Validate challenge.
        $challengeB64 = (string) ($clientData['challenge'] ?? '');
        $challengeBytes = WebAuthnHelper::base64urlDecode($challengeB64);
        $challengeHex = bin2hex($challengeBytes);
        $challengeRow = $this->challenges->consume($challengeHex, gmdate(DATE_ATOM));
        if ($challengeRow === null) {
            throw new HttpException('Invalid or expired challenge', 400);
        }
        if ($challengeRow['type'] !== 'registration') {
            throw new HttpException('Challenge type mismatch', 400);
        }
        if ((int) ($challengeRow['user_id'] ?? 0) !== $userId) {
            throw new HttpException('Challenge user mismatch', 400);
        }

        // Validate origin.
        if (($clientData['origin'] ?? '') !== $origin) {
            throw new HttpException('Origin mismatch', 400);
        }

        // Parse attestation object.
        $attestation = WebAuthnHelper::parseAttestationObject($attestationObjectBytes);
        $authData = WebAuthnHelper::parseAuthData($attestation['authData']);

        // Verify RP ID hash.
        $expectedRpIdHash = hash('sha256', $rpId, true);
        if (!hash_equals($expectedRpIdHash, $authData['rpIdHash'])) {
            throw new HttpException('RP ID mismatch', 400);
        }

        // Verify flags.
        if (!$authData['flagsDetail']['UP']) {
            throw new HttpException('User presence flag not set', 400);
        }
        if (!$authData['flagsDetail']['AT']) {
            throw new HttpException('Attested credential data flag not set', 400);
        }

        // Extract credential.
        $credentialId = $authData['credentialId'];
        $coseKey = $authData['credentialPublicKey'];

        if ($credentialId === null || $coseKey === null) {
            throw new HttpException('Missing credential data in attestation', 400);
        }

        // Verify rawId matches the credential ID from authData.
        if ($rawId !== $credentialId) {
            throw new HttpException('Credential ID mismatch', 400);
        }

        // Determine algorithm.
        $coseAlg = $coseKey[3] ?? null;
        if ($coseAlg === null) {
            throw new HttpException('Missing COSE algorithm in public key', 400);
        }
        $coseAlg = (int) $coseAlg;
        if (!in_array($coseAlg, [WebAuthnHelper::COSE_ALG_ES256, WebAuthnHelper::COSE_ALG_RS256], true)) {
            throw new HttpException('Unsupported COSE algorithm: ' . $coseAlg, 400);
        }

        // Convert COSE key to PEM.
        $publicKeyPem = WebAuthnHelper::coseKeyToPem($coseKey, $coseAlg);

        // Check for duplicate credential.
        $credentialIdHash = hash('sha256', $credentialId);
        if ($this->passkeys->findByCredentialIdHash($credentialIdHash) !== null) {
            throw new HttpException('Credential already registered', 409);
        }

        // Determine passkey name.
        $name = trim((string) ($payload['name'] ?? ''));
        if ($name === '') {
            $name = 'Passkey ' . date('Y-m-d H:i');
        }

        // Normalize transports.
        $transportsStr = null;
        if (is_array($transports) && $transports !== []) {
            $allowed = ['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'];
            $filtered = array_filter($transports, fn($t) => is_string($t) && in_array($t, $allowed, true));
            if ($filtered !== []) {
                $transportsStr = implode(',', $filtered);
            }
        }

        // Store.
        $passkey = $this->passkeys->create(
            $userId,
            $credentialId,
            $credentialIdHash,
            $publicKeyPem,
            $coseAlg,
            $authData['signCount'],
            $name,
            $transportsStr,
            $authData['aaguid']
        );

        $this->logs->log(null, 'admin.passkey.register', [
            'user_id' => $userId,
            'passkey_id' => $passkey['id'] ?? null,
        ]);

        return $this->sanitizePasskey($passkey);
    }

    public function beginAuthentication(string $rpId): array
    {
        // Purge stale challenges opportunistically.
        $this->challenges->purgeExpired(gmdate(DATE_ATOM));

        $challenge = bin2hex(random_bytes(32));
        $expiresAt = gmdate(DATE_ATOM, time() + self::CHALLENGE_TTL_SECONDS);
        $this->challenges->create($challenge, null, 'authentication', $expiresAt);

        return [
            'challenge' => $challenge,
            'rpId' => $rpId,
            'timeout' => 300000,
            'userVerification' => 'preferred',
            'allowCredentials' => [],
        ];
    }

    public function completeAuthentication(array $payload, string $rpId, string $origin): array
    {
        $rawId = $this->requireBase64url($payload, 'rawId');
        $response = $payload['response'] ?? null;
        if (!is_array($response)) {
            throw new HttpException('Missing assertion response', 400);
        }

        $authenticatorData = WebAuthnHelper::base64urlDecode((string) ($response['authenticatorData'] ?? ''));
        $clientDataJSON = WebAuthnHelper::base64urlDecode((string) ($response['clientDataJSON'] ?? ''));
        $signature = WebAuthnHelper::base64urlDecode((string) ($response['signature'] ?? ''));
        $userHandle = isset($response['userHandle']) && $response['userHandle'] !== null
            ? WebAuthnHelper::base64urlDecode((string) $response['userHandle'])
            : null;

        if ($authenticatorData === '' || $clientDataJSON === '' || $signature === '') {
            throw new HttpException('Incomplete assertion response', 400);
        }

        // Parse and validate clientDataJSON.
        $clientData = json_decode($clientDataJSON, true);
        if (!is_array($clientData)) {
            throw new HttpException('Invalid clientDataJSON', 400);
        }

        if (($clientData['type'] ?? '') !== 'webauthn.get') {
            throw new HttpException('Invalid clientDataJSON type', 400);
        }

        // Validate challenge.
        $challengeB64 = (string) ($clientData['challenge'] ?? '');
        $challengeBytes = WebAuthnHelper::base64urlDecode($challengeB64);
        $challengeHex = bin2hex($challengeBytes);
        $challengeRow = $this->challenges->consume($challengeHex, gmdate(DATE_ATOM));
        if ($challengeRow === null) {
            throw new HttpException('Invalid or expired challenge', 400);
        }
        if ($challengeRow['type'] !== 'authentication') {
            throw new HttpException('Challenge type mismatch', 400);
        }

        // Validate origin.
        if (($clientData['origin'] ?? '') !== $origin) {
            throw new HttpException('Origin mismatch', 400);
        }

        // Look up credential.
        $credentialIdHash = hash('sha256', $rawId);
        $credential = $this->passkeys->findByCredentialIdHash($credentialIdHash);
        if ($credential === null) {
            throw new HttpException('Unknown credential', 401);
        }

        // Parse authenticator data.
        $authData = WebAuthnHelper::parseAuthData($authenticatorData);

        // Verify RP ID hash.
        $expectedRpIdHash = hash('sha256', $rpId, true);
        if (!hash_equals($expectedRpIdHash, $authData['rpIdHash'])) {
            throw new HttpException('RP ID mismatch', 400);
        }

        // Verify user presence.
        if (!$authData['flagsDetail']['UP']) {
            throw new HttpException('User presence flag not set', 400);
        }

        // Verify signature.
        $valid = WebAuthnHelper::verifySignature(
            $authenticatorData,
            $clientDataJSON,
            $signature,
            (string) $credential['public_key_pem'],
            (int) $credential['cose_alg']
        );

        if (!$valid) {
            throw new HttpException('Invalid signature', 401);
        }

        // Verify sign count (warn but don't hard-fail).
        $storedCount = (int) ($credential['sign_count'] ?? 0);
        $newCount = $authData['signCount'];
        if ($storedCount > 0 && $newCount <= $storedCount) {
            error_log('[passkey] Sign count did not increase for credential ' . ($credential['id'] ?? '?') . ': stored=' . $storedCount . ' new=' . $newCount);
        }

        // Update sign count and last used.
        $this->passkeys->updateSignCount(
            (int) $credential['id'],
            $newCount,
            gmdate(DATE_ATOM)
        );

        // Verify user handle if provided (must match the stored user).
        if ($userHandle !== null && $userHandle !== '') {
            $handleUserId = unpack('N', str_pad($userHandle, 4, "\x00", STR_PAD_LEFT));
            if ($handleUserId !== false && $handleUserId[1] !== (int) $credential['user_id']) {
                throw new HttpException('User handle mismatch', 400);
            }
        }

        // Load user.
        $user = $this->users->findById((int) $credential['user_id']);
        if ($user === null || empty($user['active'])) {
            throw new HttpException('User inactive or not found', 401);
        }

        $this->logs->log(null, 'admin.auth.passkey.login', [
            'user_id' => $user['id'],
            'username' => $user['username'] ?? '',
            'passkey_id' => $credential['id'],
        ]);

        return $user;
    }

    public function listForUser(int $userId): array
    {
        $rows = $this->passkeys->findAllForUser($userId);
        return array_map([$this, 'sanitizePasskey'], $rows);
    }

    public function deletePasskey(int $id, int $userId): void
    {
        $passkey = $this->passkeys->findById($id);
        if ($passkey === null) {
            throw new HttpException('Passkey not found', 404);
        }
        if ((int) $passkey['user_id'] !== $userId) {
            throw new HttpException('Forbidden', 403);
        }

        $this->passkeys->delete($id);
        $this->logs->log(null, 'admin.passkey.delete', [
            'user_id' => $userId,
            'passkey_id' => $id,
        ]);
    }

    public function updatePasskeyName(int $id, int $userId, string $name): void
    {
        $name = trim($name);
        if ($name === '') {
            throw new ValidationException(['name' => 'Name is required']);
        }
        if (strlen($name) > 255) {
            throw new ValidationException(['name' => 'Name must be 255 characters or fewer']);
        }

        $passkey = $this->passkeys->findById($id);
        if ($passkey === null) {
            throw new HttpException('Passkey not found', 404);
        }
        if ((int) $passkey['user_id'] !== $userId) {
            throw new HttpException('Forbidden', 403);
        }

        $this->passkeys->updateName($id, $name);
    }

    private function sanitizePasskey(array $row): array
    {
        return [
            'id' => (int) ($row['id'] ?? 0),
            'name' => $row['name'] ?? '',
            'transports' => $row['transports'] ?? null,
            'created_at' => $row['created_at'] ?? null,
            'last_used_at' => $row['last_used_at'] ?? null,
        ];
    }

    private function requireBase64url(array $payload, string $key): string
    {
        $value = (string) ($payload[$key] ?? '');
        if ($value === '') {
            throw new ValidationException([$key => 'Required']);
        }
        return WebAuthnHelper::base64urlDecode($value);
    }
}
