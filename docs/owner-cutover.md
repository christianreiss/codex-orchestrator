# Owner cutover and recovery

The cutover host requires Docker Compose, Bash, Python 3, flock, GNU coreutils
and tar. The preflight verifies these tools before stopping writers.
Both API runtime images also include `flock`. The API holds a separate kernel lock
on the shared store through database fencing and effect drain. Starting another
API directly cannot bypass this storage exclusion; never delete its lock file.
The preflight prepares that regular file as mode 0600 for the API's numeric
runtime user (10001:10001 by default), preserving an existing inode and lock.
It does not widen the store directory's permissions. A custom Compose user must
be numeric; insufficient permission to prepare the file fails before writer stop.

This release has one active database owner. Deploy with `scripts/deploy.sh` after
acceptance and the communicator drain manifest have been reviewed. Preserve exact
native instances, offered/accepted work, claims and result identities throughout
the drain. A disconnected process is uncertain, not dead; never manufacture a
fresh execution to make the drain finish.

The deploy script builds images and stages wrapper artifacts while the old API
runs. It then records the currently running API, retired quota-cron and media
worker containers, pins their image IDs, stops those writers, and snapshots both
MySQL and application storage. Wrapper publication and migrations follow the
snapshot. The replacement starts once; provider quota jobs now belong to the API.
An API-only deployment also resumes a previously running media worker.

For older clients, the cutover holds database READ locks on coordination,
native identity, host and policy tables before capturing the database time.
It retains only then-active, unexpired resource/Git grants, keeps that admission
barrier until the previous writers stop, and publishes a private bounded
`.control-plane-legacy-drain.json` eligibility list. Later starts reuse this list;
they never enlarge it. Current release, revocation, binding and security state
still prevail. A fresh heartbeat from the exact original native instance and an
explicit renewal are required before a captured grant can resume. Repeated
healthy renewals stay in RAM, and the original security deadline cannot extend.
The file contains identity hashes and scope metadata, not credential values.
Failed pre-change cutovers remove their new eligibility file before restarting
the old writers. This applies with or without a backup.

When the operator explicitly declines a backup, use `scripts/deploy.sh --no-backup`.
This retains the deployment lock, target verification, old image tags and
stop-before-start ordering. It skips SQL dumps, storage archives, backup sizing
and credential/environment copies. A private metadata-only directory under
`$INSTANCE_ROOT/cutovers` (or `CODEX_DEPLOY_CUTOVER_DIR`) records the stopped
containers, sanitized configuration and phase. No database/storage rollback copy
is created; the snapshot restore procedure below does not apply. After durable
changes or new work admission, use forward repair. `--backup` and `--no-backup`
are mutually exclusive. The default backup behavior is unchanged.

`CODEX_DEPLOY_BACKUP_DIR` chooses the bundle directory (default
`$INSTANCE_ROOT/backups`). Keep it outside the application storage mount, with
space for a complete SQL dump and compressed storage. Before stopping writers,
the script checks apparent store size plus five times the database table/index
bytes and a 1 GiB reserve (`CODEX_DEPLOY_BACKUP_RESERVE_BYTES` can increase it).
This conservative bound can require an external backup disk. Failed snapshot
attempts remove only their incomplete `.tmp` payloads before recovery; completed
backups remain available. Bundles are private:
directory mode 0700, files restricted to their creator. They intentionally contain
credentials, signing material, database contents and container configuration.
Do not attach them to tickets, print them, or commit them. Retain old image tags
and bundles until the release's recovery window closes.

Each bundle contains `database.sql`, `store.tar.gz`, `SHA256SUMS`, resolved
`compose.json`, `runtime.env`, original container inspections,
`previous-images.tsv`, `running-writers.txt`, and a `phase` file. The SQL dump
includes DROP/CREATE DATABASE so a pre-start restore also removes newly added
migration tables. The store archive preserves the matching encrypted objects,
files and wrapper artifacts. `AUTH_ENCRYPTION_KEY` must match the restored data.

A failed snapshot resumes only the containers that were running before the
attempt. Inspect the failure and their health before retrying. A migration or
publication failure leaves writers stopped and the bundle intact; it does not
attempt an automatic database rollback.

## Restore before any replacement starts

A completed backup is required; `--no-backup` metadata is not restorable.
Only `quiescent` or `changing` is eligible. This procedure replaces the entire
application database and storage with the matched snapshot and discards changes
made since that snapshot. The old stopped containers must still exist. Confirm
no alternate owner or external writer has started. Use the same instance/Compose
selection as deployment; below `compose` means that exact command, including its
env file, project name and compose files. Check these against the saved private
configuration without printing secrets.

```bash
bundle=/absolute/path/to/cutover-bundle
case "$(cat "$bundle/phase")" in quiescent|changing) ;; *) exit 1 ;; esac
(cd "$bundle" && sha256sum -c SHA256SUMS)
# Verify all recorded writer containers remain stopped before restoring.
while IFS= read -r id; do
  test "$(docker inspect --format '{{.State.Running}}' "$id")" = false || exit 1
done < "$bundle/running-writers.txt"
# Use root credentials only inside the MySQL container.
compose exec -T mysql sh -lc 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' < "$bundle/database.sql"
store="$(cat "$bundle/store-path.txt")"
# Retain the changed store for investigation, then restore the complete snapshot.
mv -- "$store" "$store.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -- "$store"
tar --same-owner -xzf "$bundle/store.tar.gz" -C "$store"
printf 'replacement-started\n' > "$bundle/phase"
while IFS= read -r id; do docker start "$id"; done < "$bundle/running-writers.txt"
```

Run as the owner capable of preserving archive ownership. Verify readiness,
receipt/claim continuity, signing identity, and exact resumed native bindings.
Do not run `compose up` with the new image/config as part of this restore; starting
the recorded old containers preserves their original image, environment and
mounts. If any old container was removed, stop and reconstruct its exact
configuration from the saved inspection and pinned image before starting it.

## After replacement startup: preserve receipts and repair forward

`replacement-started` is written **before** Compose starts anything. From that
point assume new work may already have been accepted, even if startup or health
checks fail. `verified` keeps the same restriction. Do not restore the old dump
or simply start the old binary against the new schema. Stop admission, retain
current receipts/outbox/results and storage, diagnose the failure, and deploy a
compatible repair under the same exclusive-owner protocol. New backup bundles
must not replace or obscure the original evidence.

With an existing API container, the installer permits a complete wrapper matrix
check but refuses wrapper regeneration/publication; use `scripts/deploy.sh` for
that upgrade so publication follows its quiescent backup.

Installation also snapshots before schema/signing mutations. `--only schema`
leaves the API stopped deliberately: complete signing and app-tier startup before
admitting work. Successful `--only signer` resumes the exact previously running
containers. A normal install imports the signing key before starting the API.

## Acceptance evidence

Canonical API checks are Node 22 typecheck, lint, `npm test`, and build. The
separate database gate initializes a disposable MySQL baseline, applies all
migrations and runs `npm run test:coverage`. Use the actual CI system dependencies
(Python, process utilities, Git, curl), rather than treating missing executable
failures as application regressions.

Before stopping production, boot the exact image against an isolated database
with its default Docker command and verify HTTP health. Importing `buildServer`
is insufficient: bundled standalone-entrypoint guards also depend on `argv`.

The real 10-minute idle matrix remains a separate gate: 1/20/200 communicators,
Codex/Claude/Grok, and 0/1/5 admin tabs. Record SQL statement families and driver
counts, HTTP mix, API cgroup CPU, and incremental MySQL CPU. Quiet active native
sessions require zero persistent heartbeat writes. Future deadlines do not
justify repeated reads before they are due; due provider work, dirty telemetry
flushes and explicit history reads are measured separately. Simulated-clock or
service-loop tests are not evidence that this full fleet gate passed.

The opt-in harness runs a real server against a disposable lab database with
permission to create temporary databases. It can attach real Chromium tabs to
the compiled admin SPA:

```bash
cd api
TEST_USE_DB=1 TEST_DATABASE_URL="$LAB_DATABASE_URL" \
  OWNER_IDLE_SECONDS=600 OWNER_IDLE_COMMUNICATORS=200 OWNER_IDLE_TABS=5 \
  OWNER_IDLE_DELEGATE_LIVENESS=1 \
  OWNER_IDLE_CHROMIUM="$CHROMIUM_EXECUTABLE" \
  OWNER_IDLE_MYSQL_CPU_FILE=/mysql-cpu.stat OWNER_IDLE_MYSQL_EXCLUSIVE=1 \
  OWNER_IDLE_RESULT=/tmp/owner-idle-200-5tabs.json \
  npm test -- test/integration/control-plane/idle-observation.test.ts \
  --maxWorkers=1 --minWorkers=1
```

Run test containers with `--ulimit core=0`. Keep the container lifetime separate
from any one test command so a failed coverage run cannot terminate a timed
observation. Run all nine combinations of 1/20/200 communicators and 0/1/5 tabs
sequentially when they share a database. One communicator carries all three
engine identities; larger cohorts distribute identities across the three
engines. The clients are simulated TCP protocol clients, not installed Go
communicators or running native engine processes. Installed-client compatibility
needs the separate wrapper/protocol checks.

Browser cases measure quiet fetch/XHR traffic and errors, then disconnect the
browser, commit a host change, reconnect and require the missed change to appear.
Initial page hydration and that deliberate reconnect work are outside the quiet
SQL window. Browser tabs are real Chromium processes; the reported Node CPU
covers the server plus simulated clients, excluding Chromium. There are no live
provider accounts in this fixture. Due provider work, telemetry flushes, cold
history requests and adverse recovery workloads need separate evidence.

`OWNER_IDLE_MYSQL_CPU_FILE` must point to a read-only mount of the dedicated
MySQL container's `cpu.stat`. Set `OWNER_IDLE_MYSQL_EXCLUSIVE=1` only when no other
workload uses that database container. Its reported CPU is **total MySQL CPU**,
including internal housekeeping. Measure a matched 600-second no-API baseline
with unchanged database settings and no other workload, then preserve total,
baseline and their signed difference. The incremental target must not be applied
to total CPU or silently increased when housekeeping exceeds it. A small negative
difference means baseline variation, not that clients reduce database CPU.

`OWNER_IDLE_SOURCE_MANIFEST` optionally embeds a prelaunch content manifest in
each result; capture the API source, compiled SPA, dependency manifests and test
harness before launching. Do not attach a later source hash retroactively to an
earlier run. Preserve failures and distinguish completed 600-second observations
from interrupted runs. Optional `OWNER_IDLE_CPU_PROFILE` enables Inspector output
and `OWNER_IDLE_BRIDGE_TTL=30` accelerates credential renewals for diagnosis; both
change the workload or instrumentation overhead and must not replace the normal
900-second credential TTL, unprofiled acceptance run.
