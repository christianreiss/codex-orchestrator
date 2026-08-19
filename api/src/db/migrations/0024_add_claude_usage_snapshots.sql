-- Claude usage quota bar (dashboard parity with chatgpt_usage_snapshots).
--
-- Unlike ChatGPT usage, the server never holds or reuses a Claude OAuth
-- token to call any Anthropic/claude.ai endpoint directly -- Anthropic's
-- Consumer ToS prohibits third-party use of a Free/Pro/Max subscription's
-- OAuth token, and enforcement against tools that did this is a matter of
-- public record. Instead, rows here are PUSHED by the clx wrapper: Claude
-- Code itself (the real, sanctioned client) computes `rate_limits` and hands
-- it to the fleet-owned statusLine command on stdin on every render; the
-- wrapper reports that already-computed percentage up, throttled locally.
-- This table only ever stores what Claude Code itself reported.
--
-- `five_hour` / `seven_day` mirror Anthropic's own naming for the two
-- subscription windows (rate_limits.five_hour / rate_limits.seven_day) --
-- unlike chatgpt_usage_snapshots' primary/secondary, there is no positional
-- ambiguity to normalize here because the source already names the window.
CREATE TABLE IF NOT EXISTS claude_usage_snapshots (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    host_id BIGINT UNSIGNED NULL,
    source VARCHAR(32) NOT NULL DEFAULT 'statusline',
    five_hour_used_percent INT UNSIGNED NULL,
    five_hour_resets_at VARCHAR(100) NULL,
    seven_day_used_percent INT UNSIGNED NULL,
    seven_day_resets_at VARCHAR(100) NULL,
    fetched_at VARCHAR(100) NOT NULL,
    created_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    INDEX idx_claude_usage_host (host_id),
    INDEX idx_claude_usage_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
