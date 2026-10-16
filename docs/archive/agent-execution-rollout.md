# Agent execution contract v2 rollout

The contract separates durable transport acceptance from the agent's reported task outcome.
New work must wait for a receiver/relay advertising version 2. Existing leased/accepted
legacy work finishes under its original contract; installation never kills native sessions.

## Acceptance checks

- API typecheck/lint/unit contracts, real MySQL migration double-apply and bus integration.
- Go build/vet/tests, plus race checking of the delivery tracker and native result parsing.
- Frontend check/build and browser checks for schedule CRUD, recovery limits, one-use
  replacement approval, wakes refusing that approval, and mobile read-only permissions.
- Native provider canaries are separate from adapter fixtures: a green unit suite alone
  does not prove a current provider account or binary can finish a live delivery.

## Production deployment

The live host is docker01.uggs.io, checkout `/var/docker_data/codex-auth.uggs.io/app`.
Before `bash scripts/deploy.sh --backup --no-cleanup`, retain the current API and quota
images as rollback tags and copy current wrapper manifests/version metadata into a
private dated backup directory. The deploy script retains a private MySQL dump, runs
idempotent migrations and publishes wrapper 0.9.22 with the installation's public key.
Verify `/healthz`, `node migrate.js --check` inside the API container, the public admin
SPA against its committed hash, and served fleet guidance/Skill manifests.

For this host's local wrapper, verify the served linux-amd64 binary's hash and version,
copy the current executable to a private rollback path, install to a temporary filename
in `/usr/local/bin`, then atomically rename over `cxx`. Never overwrite an executing
inode. `cdx`, `clx` and `cgx` remain aliases. Snapshot existing native/wrapper PIDs and
start times before installation and compare afterward. Do not restart their services.
An old receiver/worker may therefore keep new work waiting for an adapter upgrade;
that is visible state, not authority to interrupt it.

## Rollback

Keep the additive tables and encrypted results/grants; do not restore an old database
over newer work. The least disruptive wrapper rollback is an atomic binary replacement
with the previous verified artifact while retaining the new API: queued work waits
safely for a compatible adapter. Existing processes remain intact.

Before returning to pre-v2 API code, pause affected schedules through
`PATCH /admin/schedules/:id` with the current version, let accepted work finish, and
explicitly cancel conversations containing still-queued v2 jobs through the managed
admin API after reviewing their scope. Old code cannot enforce the v2 adapter gate.
Only then select the retained API/quota images and restore the previous wrapper
manifest selection. Retain migration 0043 and its history; do not drop its tables.
