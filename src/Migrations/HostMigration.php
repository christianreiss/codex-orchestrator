<?php

namespace App\Migrations;

use PDO;

class HostMigration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS hosts (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                fqdn VARCHAR(255) NOT NULL UNIQUE,
                api_key CHAR(64) NOT NULL UNIQUE,
                api_key_hash CHAR(64) NULL,
                api_key_enc LONGTEXT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'active',
                secure TINYINT(1) NOT NULL DEFAULT 1,
                allow_roaming_ips TINYINT(1) NOT NULL DEFAULT 0,
                reverse_dns_mode TINYINT(1) NULL DEFAULT NULL,
                last_refresh VARCHAR(100) NULL,
                auth_digest VARCHAR(128) NULL,
                ip4 VARCHAR(64) NULL,
                ip6 VARCHAR(64) NULL,
                client_version VARCHAR(64) NULL,
                wrapper_version VARCHAR(64) NULL,
                agents_document_id_override BIGINT UNSIGNED NULL,
                api_calls BIGINT UNSIGNED NOT NULL DEFAULT 0,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_hosts_updated_at (updated_at)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS host_auth_digests (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NOT NULL,
                digest VARCHAR(128) NOT NULL,
                last_seen VARCHAR(100) NOT NULL,
                created_at VARCHAR(100) NOT NULL,
                UNIQUE KEY unique_host_digest (host_id, digest),
                INDEX idx_auth_digest_host (host_id),
                CONSTRAINT fk_digests_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS host_users (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NOT NULL,
                username VARCHAR(255) NOT NULL,
                hostname VARCHAR(255) NULL,
                first_seen VARCHAR(100) NOT NULL,
                last_seen VARCHAR(100) NOT NULL,
                UNIQUE KEY uniq_host_user (host_id, username),
                INDEX idx_host_users_host (host_id),
                CONSTRAINT fk_host_users_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        // Backfill new columns for existing databases.
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'ip4', 'VARCHAR(64) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'ip6', 'VARCHAR(64) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'client_version', 'VARCHAR(64) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'client_version_override', 'VARCHAR(64) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'agents_document_id_override', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'wrapper_version', 'VARCHAR(64) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'auth_digest', 'VARCHAR(128) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'api_calls', 'BIGINT UNSIGNED NOT NULL DEFAULT 0');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'allow_roaming_ips', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'secure', 'TINYINT(1) NOT NULL DEFAULT 1');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'reverse_dns_mode', 'TINYINT(1) NULL DEFAULT NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'insecure_enabled_until', 'DATETIME NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'insecure_grace_until', 'DATETIME NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'insecure_window_minutes', 'INT NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'curl_insecure', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'browseros_mcp_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->migrateHostIpColumns($pdo, $databaseName);
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'expires_at', 'VARCHAR(100) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'vip', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'lane_preference', 'VARCHAR(16) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'model_override', 'VARCHAR(128) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'reasoning_effort_override', 'VARCHAR(32) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'api_key_hash', 'CHAR(64) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'api_key_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'auto_update_override', 'TINYINT(1) NULL DEFAULT NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'last_cron_check', 'VARCHAR(100) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'scaling_exempt', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->ensureIndexExists($pdo, $databaseName, 'hosts', 'idx_hosts_expires_at', 'INDEX idx_hosts_expires_at (expires_at)');
    }

    private function migrateHostIpColumns(PDO $pdo, string $databaseName): void
    {
        $hasIp = $this->columnExists($pdo, $databaseName, 'hosts', 'ip');
        $hasIpAlt = $this->columnExists($pdo, $databaseName, 'hosts', 'ip_alt');
        $hasIp4 = $this->columnExists($pdo, $databaseName, 'hosts', 'ip4');
        $hasIp6 = $this->columnExists($pdo, $databaseName, 'hosts', 'ip6');
        $needsNormalization = false;

        if ($hasIp && !$hasIp4) {
            $pdo->exec('ALTER TABLE hosts CHANGE ip ip4 VARCHAR(64) NULL');
            $needsNormalization = true;
        }

        if ($hasIpAlt && !$hasIp6) {
            $pdo->exec('ALTER TABLE hosts CHANGE ip_alt ip6 VARCHAR(64) NULL');
            $needsNormalization = true;
        }

        $hasIp = $this->columnExists($pdo, $databaseName, 'hosts', 'ip');
        $hasIpAlt = $this->columnExists($pdo, $databaseName, 'hosts', 'ip_alt');
        $hasIp4 = $this->columnExists($pdo, $databaseName, 'hosts', 'ip4');
        $hasIp6 = $this->columnExists($pdo, $databaseName, 'hosts', 'ip6');

        if (!$hasIp4) {
            $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'ip4', 'VARCHAR(64) NULL');
            $hasIp4 = true;
        }
        if (!$hasIp6) {
            $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'ip6', 'VARCHAR(64) NULL');
            $hasIp6 = true;
        }

        if ($needsNormalization || $hasIp || $hasIpAlt) {
            $this->normalizeHostIpFamilies($pdo, $databaseName, $hasIp, $hasIpAlt);
        }

        if ($hasIp) {
            $pdo->exec('ALTER TABLE hosts DROP COLUMN ip');
        }
        if ($hasIpAlt) {
            $pdo->exec('ALTER TABLE hosts DROP COLUMN ip_alt');
        }
    }

    private function normalizeHostIpFamilies(PDO $pdo, string $databaseName, bool $hasLegacyIp, bool $hasLegacyIpAlt): void
    {
        if (!$this->columnExists($pdo, $databaseName, 'hosts', 'ip4') || !$this->columnExists($pdo, $databaseName, 'hosts', 'ip6')) {
            return;
        }

        $columns = ['id', 'ip4', 'ip6'];
        if ($hasLegacyIp && $this->columnExists($pdo, $databaseName, 'hosts', 'ip')) {
            $columns[] = 'ip';
        }
        if ($hasLegacyIpAlt && $this->columnExists($pdo, $databaseName, 'hosts', 'ip_alt')) {
            $columns[] = 'ip_alt';
        }

        $statement = $pdo->query('SELECT ' . implode(', ', $columns) . ' FROM hosts');
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (!$rows) {
            return;
        }

        $update = $pdo->prepare('UPDATE hosts SET ip4 = :ip4, ip6 = :ip6 WHERE id = :id');
        foreach ($rows as $row) {
            $ip4 = $this->firstMatchingIp([
                $row['ip4'] ?? null,
                $row['ip6'] ?? null,
                $row['ip'] ?? null,
                $row['ip_alt'] ?? null,
            ], 4);
            $ip6 = $this->firstMatchingIp([
                $row['ip4'] ?? null,
                $row['ip6'] ?? null,
                $row['ip'] ?? null,
                $row['ip_alt'] ?? null,
            ], 6);

            $currentIp4 = $this->normalizeIpRaw($row['ip4'] ?? null);
            $currentIp6 = $this->normalizeIpRaw($row['ip6'] ?? null);

            if ($ip4 !== $currentIp4 || $ip6 !== $currentIp6) {
                $update->execute([
                    'ip4' => $ip4,
                    'ip6' => $ip6,
                    'id' => (int) $row['id'],
                ]);
            }
        }
    }

    private function firstMatchingIp(array $candidates, int $family): ?string
    {
        foreach ($candidates as $candidate) {
            $normalized = $this->normalizeIpValue($candidate, $family);
            if ($normalized !== null) {
                return $normalized;
            }
        }
        return null;
    }

    private function normalizeIpValue(mixed $candidate, int $family): ?string
    {
        if (!is_string($candidate)) {
            return null;
        }
        $normalized = trim($candidate);
        if ($normalized === '') {
            return null;
        }
        $flag = $family === 4 ? FILTER_FLAG_IPV4 : FILTER_FLAG_IPV6;
        if (filter_var($normalized, FILTER_VALIDATE_IP, $flag) === false) {
            return null;
        }
        return $normalized;
    }

    private function normalizeIpRaw(mixed $candidate): ?string
    {
        if (!is_string($candidate)) {
            return null;
        }
        $normalized = trim($candidate);
        return $normalized === '' ? null : $normalized;
    }
}
