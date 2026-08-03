-- Named fleet security postures.
--
-- A profile is a level vector, not a document: the canonical prose stays one
-- fleet document so a wording fix reaches every profile, while posture varies
-- per host. `levels` is JSON because the axis set is owned by
-- `agent-security-levels.ts` and normalized on read, so adding an axis must not
-- cost a migration.
--
-- Assignment lives in its own table rather than a `hosts` column: the fleet is
-- mid-refactor retiring per-host capability booleans from `hosts`, so this stays
-- clear of that contended definition.
--
-- Additive and inert on its own. The seeded `fleet-default` profile carries the
-- Standard vector, which reproduces the policy every host is already served, so
-- applying this migration changes no served document.

CREATE TABLE IF NOT EXISTS agent_policy_profiles (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(120) NOT NULL,
    description VARCHAR(500) NULL,
    levels JSON NOT NULL,
    is_default TINYINT NOT NULL DEFAULT 0,
    revision INT UNSIGNED NOT NULL DEFAULT 1,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_agent_policy_profiles_name (name),
    KEY idx_agent_policy_profiles_is_default (is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_policy_profile_assignments (
    host_id BIGINT UNSIGNED NOT NULL,
    profile_id BIGINT UNSIGNED NOT NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (host_id),
    KEY idx_agent_policy_profile_assignments_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the fleet default at Standard. INSERT IGNORE so a re-run is a no-op and
-- an operator who has already retuned the default is never overwritten.
INSERT IGNORE INTO agent_policy_profiles
    (name, description, levels, is_default, revision, created_at, updated_at)
VALUES (
    'fleet-default',
    'Today''s fleet policy: autonomous on reversible work, stops at every external side effect.',
    '{"autonomy":3,"git_history":1,"remote_hosts":1,"deploy_release":1,"destructive_data":1,"secrets_exposure":1,"security_controls":1,"dependencies":1,"verification_waiver":0}',
    1,
    1,
    '2026-08-03T00:00:00Z',
    '2026-08-03T00:00:00Z'
);
