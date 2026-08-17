-- Pick an authorization mode for this installation.
--
-- The capability layer is default-deny: `strict` refuses any route a role does
-- not hold a capability for. That is the model this fleet should have, and it
-- is emphatically not the model existing installations *have*. Before it, six
-- hand-written gates covered 33 routes and the remaining 266 were open to any
-- authenticated account, so there was no reason for an operator to keep roles
-- meaningful — an installation whose whole team sits at `viewer` is the
-- predictable outcome of what shipped, not a misconfiguration.
--
-- This project cannot enumerate its deployments. Turning `strict` on under them
-- would lock unknown operators out of their own orchestrator during a routine
-- upgrade, with no warning that could reach them in time.
--
-- So the mode is chosen from the one fact that distinguishes the two cases at
-- migration time: whether anybody has ever signed in here.
--
--   admin_users non-empty  -> an existing installation -> 'compatible'
--   admin_users empty      -> a fresh install          -> 'strict'
--
-- A fresh install is therefore secure from its first boot, and an upgrade is a
-- behavioral no-op. `compatible` reproduces the pre-matrix rules exactly (see
-- `src/security/authorization-mode.ts`), records what `strict` would have
-- refused, and is switched off by an owner when that record says it is safe.
--
-- Ordering note: migrations run before the first owner is created, so a genuine
-- fresh install cannot see rows here. The ledger keeps this file from running a
-- second time once that install has users, and the guard below makes a manual
-- re-run inert regardless — the row is only ever written when absent, so an
-- operator's later choice is never overwritten by a migration.

SET @has_users := (SELECT COUNT(*) > 0 FROM admin_users);

SET @has_mode := (
  SELECT COUNT(*) > 0
    FROM versions
   WHERE name = 'authorization_mode'
);

INSERT INTO versions (name, version, updated_at)
SELECT
  'authorization_mode',
  IF(@has_users, 'compatible', 'strict'),
  -- Second precision, matching `nowIso()` and every other timestamp here.
  DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ')
  FROM DUAL
 WHERE NOT @has_mode;
