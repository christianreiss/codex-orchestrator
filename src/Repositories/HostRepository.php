<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Repositories;

use App\Database;
use App\Services\ConfigNormalizer;
use App\Security\SecretBox;
use App\Support\Engine;
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

    public function decryptApiKey(?string $apiKeyEnc): ?string
    {
        return $this->secretBox->decrypt($apiKeyEnc);
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
        if (!array_key_exists('vip', $host)) {
            $host['vip'] = 0;
        }
        if (!array_key_exists('lane_preference', $host)) {
            $host['lane_preference'] = null;
        }
        if (!array_key_exists('expires_at', $host)) {
            $host['expires_at'] = null;
        }
        // Engine normalization — default to 'codex' for legacy hosts.
        if (!array_key_exists('engines', $host) || $host['engines'] === null || $host['engines'] === '') {
            $host['engines'] = Engine::DEFAULT;
        }
        $host['engines_list'] = Engine::parseHostEngines($host['engines'] ?? null);

        $rawModelOverride = $host['model_override'] ?? null;
        $normalizedModelOverride = ConfigNormalizer::normalizeStoredModel($rawModelOverride);
        if ($normalizedModelOverride !== null) {
            $host['model_override'] = $normalizedModelOverride;
            if (ConfigNormalizer::isLegacyModelUpgrade($rawModelOverride)) {
                $host['reasoning_effort_override'] = ConfigNormalizer::FORCE_UPGRADE_REASONING_EFFORT;
            }
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

        return $host ? $this->normalizeStoredHost($host) : null;
    }

    public function findByFqdn(string $fqdn): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM hosts WHERE fqdn = :fqdn LIMIT 1'
        );
        $statement->execute(['fqdn' => $fqdn]);

        $host = $statement->fetch(PDO::FETCH_ASSOC);

        return $host ? $this->normalizeStoredHost($host) : null;
    }

    /**
     * @param string[] $engines Engine identifiers (e.g. ['codex'], ['claude'], ['codex','claude']).
     */
    public function create(string $fqdn, string $apiKey, bool $secure = true, array $engines = [Engine::DEFAULT]): array
    {
        $hash = $this->hashApiKey($apiKey);
        $encrypted = $this->encryptApiKey($apiKey);
        $now = gmdate(DATE_ATOM);
        $enginesStr = Engine::serializeHostEngines($engines ?: [Engine::DEFAULT]);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO hosts (fqdn, api_key, api_key_hash, api_key_enc, status, secure, vip, engines, model_override, reasoning_effort_override, created_at, updated_at)
             VALUES (:fqdn, :api_key, :api_key_hash, :api_key_enc, :status, :secure, :vip, :engines, :model_override, :reasoning_effort_override, :created_at, :updated_at)'
        );
        $statement->execute([
            'fqdn' => $fqdn,
            'api_key' => $hash,
            'api_key_hash' => $hash,
            'api_key_enc' => $encrypted,
            'status' => 'active',
            'secure' => $secure ? 1 : 0,
            'vip' => 0,
            'engines' => $enginesStr,
            'model_override' => null,
            'reasoning_effort_override' => null,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $host = $this->findByFqdn($fqdn);
        if ($host) {
            $host['api_key_plain'] = $apiKey;
        }

        return $host;
    }

    /**
     * @param string[] $engines
     */
    public function updateEngines(int $hostId, array $engines): void
    {
        $enginesStr = Engine::serializeHostEngines($engines);
        $this->updateHostFields($hostId, 'engines = :engines', ['engines' => $enginesStr]);
    }

    public function updateClaudeVersions(int $hostId, ?string $clientVersion, ?string $wrapperVersion): void
    {
        $assignments = [];
        $params = [];

        if ($clientVersion !== null) {
            $assignments[] = 'claude_client_version = :claude_client_version';
            $params['claude_client_version'] = $clientVersion;
        }

        if ($wrapperVersion !== null) {
            $assignments[] = 'claude_wrapper_version = :claude_wrapper_version';
            $params['claude_wrapper_version'] = $wrapperVersion;
        }

        if ($assignments === []) {
            return;
        }

        $this->updateHostFields($hostId, implode(', ', $assignments), $params);
    }

    public function updateClaudeAuthDigest(int $hostId, ?string $digest): void
    {
        $this->updateHostFields($hostId, 'claude_auth_digest = :digest', ['digest' => $digest]);
    }

    public function updateClaudeModelOverride(int $hostId, ?string $modelOverride): void
    {
        $this->updateHostFields($hostId, 'claude_model_override = :claude_model_override', ['claude_model_override' => $modelOverride]);
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

    public function updateIp4(int $hostId, string $ip4): void
    {
        $this->updateHostFields($hostId, 'ip4 = :ip4', ['ip4' => $ip4]);
    }

    public function updateIp6(int $hostId, ?string $ip6): void
    {
        $this->updateHostFields($hostId, 'ip6 = :ip6', ['ip6' => $ip6]);
    }

    public function updateClientVersions(int $hostId, string $clientVersion, ?string $wrapperVersion): void
    {
        $this->updateReportedVersions($hostId, $clientVersion, $wrapperVersion);
    }

    public function updateReportedVersions(int $hostId, ?string $clientVersion, ?string $wrapperVersion): void
    {
        $assignments = [];
        $params = [];

        if ($clientVersion !== null) {
            $assignments[] = 'client_version = :client_version';
            $params['client_version'] = $clientVersion;
        }

        if ($wrapperVersion !== null) {
            $assignments[] = 'wrapper_version = :wrapper_version';
            $params['wrapper_version'] = $wrapperVersion;
        }

        if ($assignments === []) {
            return;
        }

        $this->updateHostFields($hostId, implode(', ', $assignments), $params);
    }

    public function updateSyncState(int $hostId, string $lastRefresh, string $authDigest): void
    {
        $this->updateHostFields($hostId, 'last_refresh = :last_refresh, auth_digest = :auth_digest', [
            'last_refresh' => $lastRefresh,
            'auth_digest' => $authDigest,
        ]);
    }

    public function all(): array
    {
        $statement = $this->database->connection()->query(
            'SELECT * FROM hosts ORDER BY fqdn ASC'
        );

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];
        return array_map(fn (array $host): array => $this->normalizeStoredHost($host), $rows);
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

    public function findExpiredBefore(string $cutoff): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM hosts
             WHERE expires_at IS NOT NULL
               AND expires_at != \'\'
               AND expires_at < :cutoff'
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

    public function updateAllowRoaming(int $hostId, bool $allow): void
    {
        $this->updateHostFields($hostId, 'allow_roaming_ips = :allow', ['allow' => $allow ? 1 : 0], false);
    }

    public function updateSecure(int $hostId, bool $secure): void
    {
        $this->updateHostFields($hostId, 'secure = :secure', ['secure' => $secure ? 1 : 0], false);
    }

    public function updateExpiresAt(int $hostId, ?string $expiresAt): void
    {
        $this->updateHostFields($hostId, 'expires_at = :expires_at', ['expires_at' => $expiresAt]);
    }

    public function updateVip(int $hostId, bool $vip): void
    {
        $this->updateHostFields($hostId, 'vip = :vip', ['vip' => $vip ? 1 : 0], false);
    }

    public function updateScalingExempt(int $hostId, bool $exempt): void
    {
        $this->updateHostFields($hostId, 'scaling_exempt = :scaling_exempt', ['scaling_exempt' => $exempt ? 1 : 0], false);
    }

    public function updateModelOverrides(int $hostId, ?string $modelOverride, ?string $reasoningEffortOverride): void
    {
        $this->updateHostFields($hostId, 'model_override = :model_override, reasoning_effort_override = :reasoning_effort_override', [
            'model_override' => $modelOverride,
            'reasoning_effort_override' => $reasoningEffortOverride,
        ]);
    }

    public function backfillUnsupportedModelOverrides(): void
    {
        $legacyModels = array_keys(ConfigNormalizer::LEGACY_MODEL_UPGRADES);
        if ($legacyModels === []) {
            return;
        }

        $placeholders = implode(', ', array_fill(0, count($legacyModels), '?'));
        $sql = sprintf(
            'UPDATE hosts
             SET model_override = ?, reasoning_effort_override = ?, updated_at = ?
             WHERE LOWER(TRIM(COALESCE(model_override, \'\'))) IN (%s)',
            $placeholders
        );

        $statement = $this->database->connection()->prepare($sql);
        $statement->execute(array_merge(
            [
                ConfigNormalizer::FORCE_UPGRADE_MODEL,
                ConfigNormalizer::FORCE_UPGRADE_REASONING_EFFORT,
                gmdate(DATE_ATOM),
            ],
            $legacyModels
        ));
    }

    public function updateLanePreference(int $hostId, ?string $lanePreference): void
    {
        $this->updateHostFields($hostId, 'lane_preference = :lane_preference', ['lane_preference' => $lanePreference]);
    }

    public function updateClientVersionOverride(int $hostId, ?string $clientVersionOverride): void
    {
        $this->updateHostFields($hostId, 'client_version_override = :client_version_override', ['client_version_override' => $clientVersionOverride]);
    }

    public function updateAgentsDocumentOverride(int $hostId, ?int $agentsDocumentId): void
    {
        $this->updateHostFields($hostId, 'agents_document_id_override = :agents_document_id_override', ['agents_document_id_override' => $agentsDocumentId]);
    }

    public function updateInsecureWindows(int $hostId, ?string $enabledUntil, ?string $graceUntil, ?int $windowMinutes = null): void
    {
        $fields = 'insecure_enabled_until = :enabled_until, insecure_grace_until = :grace_until, updated_at = :updated_at';
        if ($windowMinutes !== null) {
            $fields .= ', insecure_window_minutes = :window_minutes';
        }

        $statement = $this->database->connection()->prepare(
            sprintf('UPDATE hosts SET %s WHERE id = :id', $fields)
        );

        $params = [
            'enabled_until' => $enabledUntil,
            'grace_until' => $graceUntil,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ];

        if ($windowMinutes !== null) {
            $params['window_minutes'] = $windowMinutes;
        }

        $statement->execute($params);
    }

    public function updateAutoUpdateOverride(int $hostId, ?bool $override): void
    {
        $this->updateHostFields($hostId, 'auto_update_override = :override', ['override' => $override === null ? null : ($override ? 1 : 0)]);
    }

    public function touchLastCronCheck(int $hostId): void
    {
        $this->updateHostFields($hostId, 'last_cron_check = :now', ['now' => gmdate(DATE_ATOM)], false);
    }

    public function updateCurlInsecure(int $hostId, bool $curlInsecure): void
    {
        $this->updateHostFields($hostId, 'curl_insecure = :curl_insecure', ['curl_insecure' => $curlInsecure ? 1 : 0]);
    }

    public function updateReverseDnsMode(int $hostId, ?bool $enabled): void
    {
        $this->updateHostFields($hostId, 'reverse_dns_mode = :mode', ['mode' => $enabled === null ? null : ($enabled ? 1 : 0)]);
    }

    /**
     * Execute a SET-clause UPDATE on the hosts table for a given host ID.
     * $set must be a trusted internal string — never pass user input directly.
     * When $touchUpdatedAt is true (the default), appends "updated_at = :updated_at".
     *
     * @param array<string, mixed> $params
     */
    private function updateHostFields(int $hostId, string $set, array $params, bool $touchUpdatedAt = true): void
    {
        if ($touchUpdatedAt) {
            $set .= ', updated_at = :updated_at';
            $params['updated_at'] = gmdate(DATE_ATOM);
        }
        $params['id'] = $hostId;
        $statement = $this->database->connection()->prepare(
            "UPDATE hosts SET {$set} WHERE id = :id"
        );
        $statement->execute($params);
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
