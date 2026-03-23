<?php

namespace App\Http;

final class PayloadHelper
{
    /**
     * @return array{command:string,last_refresh:string,digest:string,installation_id?:string}
     */
    public static function extractSyncAuthFingerprint(mixed $payload): array
    {
        $defaultDigest = hash('sha256', '{"last_refresh":"2000-01-01T00:00:00Z","auths":{}}');
        $authPayload = [];
        if (is_array($payload) && isset($payload['auth']) && is_array($payload['auth'])) {
            $authPayload = $payload['auth'];
        } elseif (is_array($payload)) {
            $authPayload = $payload;
        }

        $lastRefresh = '2000-01-01T00:00:00Z';
        if (isset($authPayload['last_refresh']) && is_string($authPayload['last_refresh']) && trim($authPayload['last_refresh']) !== '') {
            $lastRefresh = trim($authPayload['last_refresh']);
        }

        $digest = $defaultDigest;
        if (isset($authPayload['digest']) && is_string($authPayload['digest'])) {
            $candidate = strtolower(trim($authPayload['digest']));
            if (preg_match('/^[a-f0-9]{64}$/', $candidate) === 1) {
                $digest = $candidate;
            }
        }

        $result = [
            'command' => 'retrieve',
            'last_refresh' => $lastRefresh,
            'digest' => $digest,
        ];

        if (
            is_array($payload)
            && array_key_exists('installation_id', $payload)
            && is_string($payload['installation_id'])
            && trim($payload['installation_id']) !== ''
        ) {
            $result['installation_id'] = trim((string) $payload['installation_id']);
        }

        return $result;
    }

    public static function extractSyncAuthCandidate(mixed $payload): ?array
    {
        if (!is_array($payload)) {
            return null;
        }

        if (isset($payload['auth_candidate']) && is_array($payload['auth_candidate'])) {
            return $payload['auth_candidate'];
        }

        return null;
    }

    /**
     * @return array{username:?string,hostname:?string}
     */
    public static function extractSyncHostUserInput(mixed $payload): array
    {
        $source = [];
        if (is_array($payload) && isset($payload['host_user']) && is_array($payload['host_user'])) {
            $source = $payload['host_user'];
        } elseif (is_array($payload)) {
            $source = $payload;
        }

        $username = null;
        if (isset($source['username']) && is_string($source['username']) && trim($source['username']) !== '') {
            $username = trim($source['username']);
        }

        $hostname = null;
        if (isset($source['hostname']) && is_string($source['hostname']) && trim($source['hostname']) !== '') {
            $hostname = trim($source['hostname']);
        }

        return [
            'username' => $username,
            'hostname' => $hostname,
        ];
    }
}
