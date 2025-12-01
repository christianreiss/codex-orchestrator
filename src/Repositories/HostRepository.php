<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Repositories;

use App\Database;
use App\Security\SecretBox;
use PDO;

class HostRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly SecretBox $secretBox
    )
    {
    }

    private function hashApiKey(string $apiKey): string
    {
        return hash('sha256', $apiKey);
    }

    private function encryptApiKey(string $apiKey): string
    {
        return $this->secretBox->encrypt($apiKey);
    }

    private function normalizeStoredHost(array $host): array
    {
        // For backwards compatibility, populate api_key_hash if missing but api_key exists (legacy plaintext/hash).
        if (!isset($host['api_key_hash']) && isset($host['api_key']) && is_string($host['api_key'])) {
            $host['api_key_hash'] = $host['api_key'];
        }
        if (!array_key_exists('secure', $host)) {
            $host['secure'] = 1;
        }
        return $host;
    }

    public function backfillApiKeyEncryption(): void
    {
        $statement = $this->database->connection()->query(
            'SELECT id, api_key, api_key_hash, api_key_enc FROM hosts'
        );
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (!$rows) {
            return;
        }

        foreach ($rows as $row) {
            $id = (int) ($row['id'] ?? 0);
            if ($id <= 0) {
                continue;
            }
            $stored = $row['api_key'] ?? '';
            $hasHash = isset($row['api_key_hash']) && $row['api_key_hash'] !== null && $row['api_key_hash'] !== '';
            $hasEnc = isset($row['api_key_enc']) && $row['api_key_enc'] !== null && $row['api_key_enc'] !== '';

            if ($stored === '' || ($hasHash && $hasEnc)) {
                continue;
            }

            $hash = $this->hashApiKey($stored);
            $enc = $this->encryptApiKey($stored);

            $update = $this->database->connection()->prepare(
                'UPDATE hosts SET api_key = :api_key, api_key_hash = :api_key_hash, api_key_enc = :api_key_enc WHERE id = :id'
            );
            $update->execute([
                'api_key' => $hash,
                'api_key_hash' => $hash,
                'api_key_enc' => $enc,
                'id' => $id,
            ]);
        }
    }

    public function findByApiKey(string $apiKey): ?array
    {
        $hash = $this->hashApiKey($apiKey);

        $statement = $this->database->connection()->prepare(
            'SELECT * FROM hosts WHERE api_key_hash = :hash LIMIT 1'
        );
        $statement->execute(['hash' => $hash]);

        $host = $statement->fetch(PDO::FETCH_ASSOC);

        // Fallback to legacy column if hash not found.
        if (!$host) {
            $legacy = $this->database->connection()->prepare(
                'SELECT * FROM hosts WHERE api_key = :api_key LIMIT 1'
            );
            $legacy->execute(['api_key' => $apiKey]);
            $host = $legacy->fetch(PDO::FETCH_ASSOC);
        }

        return $host ? $this->normalizeStoredHost($host) : null;
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM hosts WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);

        $host = $statement->fetch(PDO::FETCH_ASSOC);

        return $host ?: null;
    }

    public function findByFqdn(string $fqdn): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM hosts WHERE fqdn = :fqdn LIMIT 1'
        );
        $statement->execute(['fqdn' => $fqdn]);

        $host = $statement->fetch(PDO::FETCH_ASSOC);

        return $host ?: null;
    }

    public function create(string $fqdn, string $apiKey, bool $secure = true): array
    {
        $hash = $this->hashApiKey($apiKey);
        $encrypted = $this->encryptApiKey($apiKey);
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO hosts (fqdn, api_key, api_key_hash, api_key_enc, status, secure, created_at, updated_at)
             VALUES (:fqdn, :api_key, :api_key_hash, :api_key_enc, :status, :secure, :created_at, :updated_at)'
        );
        $statement->execute([
            'fqdn' => $fqdn,
            'api_key' => $hash,
            'api_key_hash' => $hash,
            'api_key_enc' => $encrypted,
            'status' => 'active',
            'secure' => $secure ? 1 : 0,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $host = $this->findByFqdn($fqdn);
        if ($host) {
            $host['api_key_plain'] = $apiKey;
        }

        return $host;
    }

    public function rotateApiKey(int $hostId, string $apiKey): ?array
    {
        $hash = $this->hashApiKey($apiKey);
        $encrypted = $this->encryptApiKey($apiKey);
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET api_key = :api_key, api_key_hash = :api_key_hash, api_key_enc = :api_key_enc, updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'api_key' => $hash,
            'api_key_hash' => $hash,
            'api_key_enc' => $encrypted,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);

        $host = $this->findById($hostId);
        if ($host) {
            $host['api_key_plain'] = $apiKey;
        }
        return $host;
    }

    public function updateIp(int $hostId, string $ip): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET ip = :ip, updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'ip' => $ip,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);
    }

    public function updateClientVersions(int $hostId, string $clientVersion, ?string $wrapperVersion): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET client_version = :client_version, wrapper_version = :wrapper_version, updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'client_version' => $clientVersion,
            'wrapper_version' => $wrapperVersion,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);
    }

    public function updateSyncState(int $hostId, string $lastRefresh, string $authDigest): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET last_refresh = :last_refresh, auth_digest = :auth_digest, updated_at = :updated_at WHERE id = :id'
        );

        $statement->execute([
            'last_refresh' => $lastRefresh,
            'auth_digest' => $authDigest,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);
    }

    public function touch(int $hostId): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);
    }

    public function all(): array
    {
        $statement = $this->database->connection()->query(
            'SELECT * FROM hosts ORDER BY fqdn ASC'
        );

        return $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }

    public function findInactiveBefore(string $cutoff): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM hosts WHERE updated_at < :cutoff'
        );
        $statement->execute(['cutoff' => $cutoff]);

        return $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }

    public function findUnprovisionedBefore(string $cutoff): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM hosts
             WHERE (last_refresh IS NULL OR last_refresh = \'\')
               AND (auth_digest IS NULL OR auth_digest = \'\')
               AND COALESCE(api_calls, 0) = 0
               AND created_at < :cutoff'
        );
        $statement->execute(['cutoff' => $cutoff]);

        return $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }

    public function deleteByIds(array $ids): void
    {
        if (!$ids) {
            return;
        }

        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $statement = $this->database->connection()->prepare(
            "DELETE FROM hosts WHERE id IN ({$placeholders})"
        );
        $statement->execute($ids);
    }

    public function deleteById(int $id): void
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM hosts WHERE id = :id'
        );
        $statement->execute(['id' => $id]);
    }

    public function updateAuthDigest(int $hostId, ?string $authDigest, ?string $updatedAt = null): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET auth_digest = :auth_digest, updated_at = :updated_at WHERE id = :id'
        );

        $statement->execute([
            'auth_digest' => $authDigest,
            'updated_at' => $updatedAt ?? gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);
    }

    public function incrementApiCalls(int $hostId, int $by = 1): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET api_calls = COALESCE(api_calls, 0) + :by, updated_at = :updated_at WHERE id = :id'
        );

        $statement->execute([
            'by' => $by,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);
    }

    public function clearIp(int $hostId): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET ip = NULL, updated_at = :updated_at WHERE id = :id'
        );

        $statement->execute([
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);
    }

    public function updateAllowRoaming(int $hostId, bool $allow): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET allow_roaming_ips = :allow WHERE id = :id'
        );

        $statement->execute([
            'allow' => $allow ? 1 : 0,
            'id' => $hostId,
        ]);
    }

    public function updateSecure(int $hostId, bool $secure): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET secure = :secure WHERE id = :id'
        );

        $statement->execute([
            'secure' => $secure ? 1 : 0,
            'id' => $hostId,
        ]);
    }

    public function updateInsecureWindows(int $hostId, ?string $enabledUntil, ?string $graceUntil): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET insecure_enabled_until = :enabled_until, insecure_grace_until = :grace_until, updated_at = :updated_at WHERE id = :id'
        );

        $statement->execute([
            'enabled_until' => $enabledUntil,
            'grace_until' => $graceUntil,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);
    }

    public function updateForceIpv4(int $hostId, bool $forceIpv4): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET force_ipv4 = :force_ipv4, ip = NULL, updated_at = :updated_at WHERE id = :id'
        );

        $statement->execute([
            'force_ipv4' => $forceIpv4 ? 1 : 0,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);
    }

    /**
     * Clear canonical auth state for a host without deleting the host record.
     * Resets the stored digest/last_refresh and removes any host->payload pointer
     * so the next sync behaves like a first-time upload.
     */
    public function clearHostAuth(int $hostId): void
    {
        $pdo = $this->database->connection();

        $statement = $pdo->prepare(
            'UPDATE hosts SET last_refresh = NULL, auth_digest = NULL, updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);

        // Remove host -> canonical payload pointer to avoid serving stale digests.
        $stmtState = $pdo->prepare('DELETE FROM host_auth_states WHERE host_id = :host_id');
        $stmtState->execute(['host_id' => $hostId]);
    }
}
