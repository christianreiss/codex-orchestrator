<?php

declare(strict_types=1);

namespace App\Migrations;

use PDO;

/**
 * Adds multi-engine (codex + claude) support across the schema.
 *
 * After this migration every relevant table carries an `engine` column
 * so the orchestrator can manage Codex and Claude hosts side-by-side.
 */
class EngineMigration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        // ── hosts ─────────────────────────────────────────────
        // Which engines are installed on this host (comma-separated: codex, claude, codex,claude).
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'engines', "VARCHAR(32) NOT NULL DEFAULT 'codex'");
        // Claude-specific version tracking (Codex versions stay in client_version / wrapper_version).
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'claude_client_version', 'VARCHAR(64) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'claude_wrapper_version', 'VARCHAR(64) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'claude_auth_digest', 'VARCHAR(128) NULL');
        // Claude-specific model/effort overrides.
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'claude_model_override', 'VARCHAR(128) NULL');

        // ── auth_payloads ─────────────────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'auth_payloads', 'engine', "VARCHAR(16) NOT NULL DEFAULT 'codex'");
        $this->ensureIndexExists($pdo, $databaseName, 'auth_payloads', 'idx_auth_payloads_engine', 'INDEX idx_auth_payloads_engine (engine)');

        // ── host_auth_states ──────────────────────────────────
        // Per-engine auth state tracking. For existing rows the default is 'codex'.
        $this->ensureColumnExists($pdo, $databaseName, 'host_auth_states', 'engine', "VARCHAR(16) NOT NULL DEFAULT 'codex'");

        // ── host_auth_digests ─────────────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'host_auth_digests', 'engine', "VARCHAR(16) NOT NULL DEFAULT 'codex'");

        // ── install_tokens ────────────────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'install_tokens', 'engine', "VARCHAR(16) NOT NULL DEFAULT 'codex'");

        // ── cli_auth_requests ─────────────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'cli_auth_requests', 'engine', "VARCHAR(16) NOT NULL DEFAULT 'codex'");

        // ── skills ────────────────────────────────────────────
        // NULL = universal (served to both engines), 'codex' or 'claude' = engine-specific.
        $this->ensureColumnExists($pdo, $databaseName, 'skills', 'engine', 'VARCHAR(16) NULL');
        $this->ensureIndexExists($pdo, $databaseName, 'skills', 'idx_skills_engine', 'INDEX idx_skills_engine (engine)');

        // ── agents_documents ──────────────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'agents_documents', 'engine', "VARCHAR(16) NOT NULL DEFAULT 'codex'");
        $this->ensureIndexExists($pdo, $databaseName, 'agents_documents', 'idx_agents_documents_engine', 'INDEX idx_agents_documents_engine (engine)');

        // ── agents_document_state ─────────────────────────────
        // The state singleton becomes per-engine; we use engine as part of a composite key.
        $this->ensureColumnExists($pdo, $databaseName, 'agents_document_state', 'engine', "VARCHAR(16) NOT NULL DEFAULT 'codex'");

        // ── client_config_documents ───────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'client_config_documents', 'engine', "VARCHAR(16) NOT NULL DEFAULT 'codex'");
        $this->ensureIndexExists($pdo, $databaseName, 'client_config_documents', 'idx_client_config_engine', 'INDEX idx_client_config_engine (engine)');

        // ── token_usages ──────────────────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'token_usages', 'engine', "VARCHAR(16) NULL DEFAULT 'codex'");
        $this->ensureIndexExists($pdo, $databaseName, 'token_usages', 'idx_token_usage_engine', 'INDEX idx_token_usage_engine (engine)');

        // ── token_usage_ingests ───────────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'token_usage_ingests', 'engine', "VARCHAR(16) NULL DEFAULT 'codex'");
        $this->ensureIndexExists($pdo, $databaseName, 'token_usage_ingests', 'idx_usage_ingests_engine', 'INDEX idx_usage_ingests_engine (engine)');

        // ── openai_api_keys → api_keys ────────────────────────
        // Add engine awareness to the existing API keys table so it can serve both engines.
        $this->ensureColumnExists($pdo, $databaseName, 'openai_api_keys', 'engine', "VARCHAR(16) NOT NULL DEFAULT 'codex'");
        $this->ensureIndexExists($pdo, $databaseName, 'openai_api_keys', 'idx_openai_keys_engine', 'INDEX idx_openai_keys_engine (engine)');

        // ── mcp_memories ──────────────────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'mcp_memories', 'engine', 'VARCHAR(16) NULL');

        // ── mcp_access_logs ───────────────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'mcp_access_logs', 'engine', 'VARCHAR(16) NULL');

        // ── logs ──────────────────────────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'logs', 'engine', 'VARCHAR(16) NULL');

        // ── insecure_auth_requests ────────────────────────────
        $this->ensureColumnExists($pdo, $databaseName, 'insecure_auth_requests', 'engine', "VARCHAR(16) NOT NULL DEFAULT 'codex'");

        // ── Claude pricing defaults ───────────────────────────
        // Seed pricing for Claude models if not already present.
        $this->seedClaudePricing($pdo);
    }

    private function seedClaudePricing(PDO $pdo): void
    {
        $models = [
            [
                'model' => 'claude-opus-4-6',
                'input_price_per_1k' => 0.015,
                'output_price_per_1k' => 0.075,
                'cached_price_per_1k' => 0.0075,
            ],
            [
                'model' => 'claude-sonnet-4-6',
                'input_price_per_1k' => 0.003,
                'output_price_per_1k' => 0.015,
                'cached_price_per_1k' => 0.0015,
            ],
            [
                'model' => 'claude-haiku-4-5',
                'input_price_per_1k' => 0.0008,
                'output_price_per_1k' => 0.004,
                'cached_price_per_1k' => 0.0004,
            ],
        ];

        $now = gmdate(DATE_ATOM);

        foreach ($models as $m) {
            $check = $pdo->prepare('SELECT COUNT(*) FROM pricing_snapshots WHERE model = :model');
            $check->execute(['model' => $m['model']]);

            if ((int) $check->fetchColumn() > 0) {
                continue;
            }

            $insert = $pdo->prepare(
                'INSERT INTO pricing_snapshots (model, currency, input_price_per_1k, output_price_per_1k, cached_price_per_1k, source_url, fetched_at, created_at)
                 VALUES (:model, :currency, :input, :output, :cached, :source, :fetched, :created)'
            );
            $insert->execute([
                'model' => $m['model'],
                'currency' => 'USD',
                'input' => $m['input_price_per_1k'],
                'output' => $m['output_price_per_1k'],
                'cached' => $m['cached_price_per_1k'],
                'source' => 'https://docs.anthropic.com/en/docs/about-claude/pricing',
                'fetched' => $now,
                'created' => $now,
            ]);
        }
    }
}
