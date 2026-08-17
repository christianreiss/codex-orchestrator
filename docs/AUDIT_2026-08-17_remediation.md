# Remediation status — worktree at `13b4093f`, 2026-08-17

Two external reviews produced remediation briefs for this repository. The first
was written against `6c0866d3` and is closed out below under **Earlier pass**.
The second, written against `13b4093f`, is an eleven-phase brief covering RBAC,
provider transports, the runner contract, god-object decomposition, the Go
wrappers, the frontend, auth concurrency, dead security surface, supply chain,
and documentation.

This file records what was actually done against the second brief, and — more
importantly — what was **not**. Every item is either **done** (landed, with the
gate that proves it) or **outstanding** (named, with why it did not land). There
is no third category, and "outstanding" is not a euphemism for "partially
started": nothing below is half-decomposed.

---

## Scope taken this pass

The brief is eleven phases across ~200k lines. Taking it breadth-first would
violate its own Rule 2: extracting three of nine bounded contexts out of
`agent-messaging.ts` leaves a 2,800-line facade that re-glues them, which the
brief explicitly forbids. So this pass went depth-first and took **Phase 1 to
completion**, plus the documentation obligations Phase 11 attaches to it.

Phases 2–10 are untouched and are listed as outstanding below with the same
honesty the earlier pass used.

---

## Done: Phase 1 — central, default-deny RBAC / capability layer

### What was actually wrong

`requireAdmin` (`api/src/http/plugins/auth-admin.ts`) resolves the session
cookie and requires an active user row. It has never read `access_level`. Six
hand-written preHandlers scattered across six route files were the entire
authorization surface, and they covered 33 routes out of **299** under
`/admin/*` and `/cli/auth/*`.

Everything else was open to any authenticated, active account, including a
`viewer`:

- `POST /admin/auth/upload` — upload canonical fleet credentials
- `POST /admin/auth/seed-command` — mint a seed command
- `POST /admin/runner/run{,-claude}` — drive the fleet runner
- `POST /admin/hosts/:id/insecure/enable`, `.../insecure/extend` and the
  approval rulings — open and extend insecure windows
- every global setting: quota mode, scaling, log retention, prune policy,
  auto-update, model defaults, engine enablement, provider API keys
- every content-authoring route: agent documents, skills, Claude collections,
  the config builder, agent policy profiles
- every project mutation
- `POST /cli/auth/deny`

`docs/ADMIN.md` and `docs/LOGIN.md` described this accurately, which is the one
thing that had been fixed already. They also both stated, in as many words,
that the API has no capability system.

### What landed

| Piece | File |
|---|---|
| Closed capability vocabulary + role→capability matrix | `api/src/security/capabilities.ts` |
| Route→capability inventory, all 299 governed routes | `api/src/security/route-capabilities.ts` |
| Enforcement plugin; refuses to boot on an unmapped route | `api/src/http/plugins/capabilities.ts` |
| Generated docs table | `api/src/security/capability-docs.ts`, `api/scripts/render-capability-docs.ts` |
| Console consumption | `frontend/src/lib/auth/capabilities.ts`, `frontend/src/lib/stores/auth.ts` |

Design notes that matter for review:

- **The inventory is a table, not an argument at 299 call sites.** The whole
  authorization surface is one file a reviewer reads top to bottom to answer
  "who can delete a host". The plugin's `onRoute` hook looks each route up as it
  registers and attaches the guard, collecting every miss and throwing once at
  `onReady` with the full list. A route with no entry is a **startup failure**,
  not a session-only route — which is the property that makes this default-deny
  rather than best-effort.
- **The guard is appended, never prepended.** Routes that serve the admin SPA's
  HTML shell put that preHandler first on purpose, so a browser navigating to
  `/admin/secrets` gets the app rather than a 401 JSON body. It replies and
  short-circuits; an XHR asking for JSON falls through to the capability check.
- **The check is idempotent on `req.admin`,** so stacking it behind the existing
  `requireAdmin` costs no second session lookup.
- **`requireAdmin` stays.** It authenticates. It never authorized, and now
  nothing pretends it did.

### The matrix, and the three capabilities the brief did not name

`owner` and `admin` hold everything; they differ only in the ownership
invariants in `admin-users.ts`, which are properties of the *target* row and
cannot be expressed as a capability of the caller. `viewer` and legacy `user`
are read-only. Beyond the brief's list, three capabilities were added:

- **`hosts.security_transition`** — host delete, registration, engine change,
  secure-state transition, and CLI approval. Split out of `hosts.manage` because
  those five carried the old owner/admin gate: folding them into `hosts.manage`
  would have handed them to `fleet_operator`, which is a regression dressed as a
  refactor. It also satisfies the brief's §1.5 ("Host-Delete und
  Sicherheitsübergänge sind default-deny").
- **`account.self_manage`** — logout, own password, own passkeys. Held by every
  role: an account you cannot sign out of or re-secure is worse than no account.
- **`auth.reveal_credential`** — reading a stored canonical credential body back
  out. Found while re-reading the inventory:
  `GET /admin/hosts/{id}/auth?include_body=1` returns the live credential the
  fleet distributes to hosts, and was reachable by any signed-in account. It has
  no caller in the console, the wrappers or the runner — it is an operator
  affordance — so gating it costs nothing. This is the one capability a route
  raises itself, because the same URL is metadata without the flag: the
  inventory sets `auth.read_metadata` as the floor and the handler calls
  `app.assertCapability(req, 'auth.reveal_credential')`. Still not an ad-hoc
  role check — the decision comes from the same matrix and the caller names a
  capability, never a role.

Judgment calls worth disagreeing with, stated rather than buried:

- `fleet_operator` holds **`auth.manage`** — canonical credential upload, seed
  commands, and `POST /admin/runner/run{,-claude}`, which spawns a subprocess
  with fleet credentials. Defensible because fleet auth is this product's
  central fleet operation, and the runner path is bounded by the work in
  `37c4e510`/`539b0706`. If your operators should not hold it, remove it from
  `FLEET_OPERATOR` in `capabilities.ts` — the matrix is one array.
- `fleet_operator` does **not** hold `keys.manage`. Provider API keys are
  billable bearer credentials, and the brief lists `keys.manage` separately from
  `settings.manage` precisely because it is more sensitive.
- `fleet_operator` does **not** hold `content.manage`, `memory.write`,
  `projects.manage`, `agent_portal.manage` or `agent_messaging.manage`. The last
  two would have widened an existing gate; the first three are content
  authoring, not fleet operation.

### Breaking change

On upgrade, `viewer`, `user`, `trusted_user` and `fleet_operator` accounts
**lose access they have today**. `fleet_operator` and `trusted_user` previously
had no distinct meaning at all — they were legacy values accepted so old rows
kept loading — and now they do. Nothing that was restricted became less
restricted; the 33 previously-gated routes are pinned against widening.

Recorded in `CHANGELOG.md` and in an upgrade note under `docs/ADMIN.md`'s
`## Roles & Capabilities`.

### Gates that hold it

| Test | What fails it |
|---|---|
| `api/test/unit/security/route-capability-coverage.test.ts` | Boots the real `registerAllRoutes` tree, with and without the committed admin bundle. Fails on any governed route with no entry, any inventory entry for a route that no longer exists, any capability name that is not in the vocabulary, and any drift in the pinned pre-authentication surface. Also asserts the plugin refuses `app.ready()` on an unmapped route. |
| `api/test/unit/security/capability-layer-invariants.test.ts` | The 33 previously-gated routes must still resolve to a capability no role beyond owner/admin holds — in both directions. Scans `api/src/routes/**` and fails on any role comparison at all. |
| `api/test/integration/security/capability-matrix.test.ts` | 56 real HTTP requests: every role in `VALID_ACCESS_LEVELS` against a probe from every capability family, asserting the status code *and* that a refusal reached no storage. |
| `api/test/integration/security/capability-edges.test.ts` | The bootstrap window (open before the first owner, closed after); the credential-body gate on `include_body=1` across all six roles; and the SPA short-circuit (a refused role may receive the app shell, never a JSON body — six `Accept` headers). |
| `api/test/unit/security/capability-docs.test.ts` | Re-renders the matrix table and compares it to `docs/ADMIN.md`; fails if any capability is held by no role; fails if either doc still denies the capability system or describes the six-gate model. |
| `frontend/src/lib/auth/capability-parity.test.ts` | Parses the API's `CAPABILITIES` tuple and requires the console's copy to match exactly, in order. |

The bootstrap classification deserves a specific note, because it is the one
guard whose anonymous path is open by design. `/admin/setup/*` and
`POST /admin/users` must run unauthenticated on an installation with no owner.
What closes that window is each route's own `requireAdminAfterSetup` /
`requireAdminOrBootstrap`, which counts users and demands a session once there
is one — an assumption held in another file. The plugin therefore **refuses to
start** if a bootstrap-classified route carries no preHandler of its own, and
`capability-edges.test.ts` proves both halves.

### Console

`GET /admin/auth/status` returns the caller's row of the matrix. The console
reads it through `authStore.can()` and uses it to disable controls a `403` would
meet. This replaced five hand-rolled `owner|admin` derivations in the UI
(`AgentMessagingSection`, `agent-portal`, `agent-messaging`,
`MattPocockSkillsSource`, `memories`) and added gating to two surfaces that had
none (`secrets`, `users`). Reveal controls now key on their own capability
rather than on "manage", matching the server. `RowActions` carries a `reason`
so a disabled control says which capability it wants.

A missing `capabilities` field falls to read-only rather than assuming a
permission — the conservative direction, and the only one that cannot invent a
grant.

---

## Outstanding

Not started. Each is named with why, not with a plan.

### 1. Phase 2 — provider transports, streaming, tools, embeddings, exact tokens

Unchanged from the earlier pass, and the reasoning still holds: the compat
gateways shell out to a CLI, neither official SDK is a dependency here, and the
brief's own contract tests require live provider credentials and billable calls.
Callers can no longer *ask* for a control the transport cannot honor
(`539b0706`), and stop reasons are `null` rather than invented — but the
transport still cannot stream incrementally, round-trip tool calls, serve
embeddings, or count tokens exactly. `transport-capabilities.ts` is shaped to
take a second transport entry when real adapters land.

The brief additionally asks (§2.5.3) that the invented
`POST /anthropic/v1/embeddings` route be **removed**, not merely honest. It
currently returns a typed `501`. Verified, not changed — removing a published
route is a contract break that belongs with the adapter work, not beside it.

### 2. Phase 3 — runner contract, capacity, redaction, modularization

`runner/app.py` is 1,530 lines. Discriminated request models, bounded
per-workload queues with reserved capacity for credential verification,
structured errors with a central redactor, and the twelve-module split are not
started. The SSRF and input-bounding work from `37c4e510` stands and was
re-verified by `pytest`.

### 3. Phase 4 — engine-neutral fresh-install readiness

Managed features still depend on a Codex `client_config_documents` row, so the
wizard writes Codex defaults even for "neither engine". Needs a migration, a
backfill, and the `persisted`/`source` fields on `GET model-defaults`. Not
started.

### 4. Phase 5 — god-object decomposition

`agent-messaging.ts` (4,226 lines), `agent-portal.ts` (2,470),
`shared-memories.ts` (1,471), `canonical-auth-store.ts` (1,439),
`host-projects.ts` (1,362) and `mcp-tools.ts` (1,187) are untouched as
structures. These own delivery idempotency, lock ordering, encryption and
revocation semantics, and the brief requires characterization tests *before*
splitting them. No architecture/complexity budget was added, because adding one
the tree fails on day one is theatre — it belongs in the same change as the
decomposition.

### 5. Phase 6 — Go wrapper deduplication

Shared engine-neutral packages for lifecycle, locks, HTTP client, atomic writes,
sync phases, update and uninstall are not started.

### 6. Phase 7 — frontend modularization

The 1,104-line authoring page, the generic artifact workspace for Claude
collections, and splitting `frontend/src/lib/api/types.ts` by domain are not
started. Phase 1's §1.6 obligation (capabilities drive controls) is done; the
structural work is not.

### 7. Phase 8 — multi-instance auth coordination

Process-local `Map` single-flights still stand in for DB-backed leases and
fencing, and auth correctness still assumes one API process. Not started.

### 8. Phase 9.1–9.3 — dead security surface, recovery, first-owner claim

- `[security].dangerously_bypass_approvals_and_sandbox` remains inert: the
  server renders a key nobody reads, the wrapper reads a key nobody writes. It
  is **not** activated. Removing and migrating it is not started.
- No auditable local passkey/admin recovery CLI. `docs/ADMIN.md` still tells an
  owner who lost every passkey to delete `admin_passkeys` rows by hand.
- No setup-claim token on first-owner creation. The claim is atomic against a
  concurrent second claim, but it is not token-bound.

### 9. Phase 10 — supply chain, images, CI

Runtime and dev Python dependencies are split (`requirements.txt` /
`requirements-dev.txt`, verified). Base images and CI actions are digest-pinned
(verified). Not started: a Python lock/hash strategy, `ruff format --check` as a
gate, reproducible wrapper builds from `SOURCE_DATE_EPOCH`, SBOM and
vulnerability gates, container hardening beyond non-root, a compose-based E2E
matrix, and arm64 builds.

`ruff format --check` deserves its own line because it conflicts with a
deliberate deviation the earlier pass recorded: the repository has never carried
a ruff config, and adopting the formatter rewrites ~1,350 lines of pre-existing
code. The brief mandates it and the brief wins — but it belongs in an isolated
change set, per the brief's own "kontrolliert statt eines unreviewbaren
Misch-Diffs". It is not in this one.

### 10. Phase 11 — remaining documentation contradictions

The authorization documentation is now correct and test-held. The
streaming/tools/embeddings/token-counting claims are honest as of the earlier
pass. Not re-audited: the Caddy / mTLS / `ADMIN_ACCESS_MODE` claims and the
fresh-install readiness text, both of which describe subsystems this pass did
not touch.

---

## Gates run

```
api:       npm run typecheck  — clean
           npm run lint       — 0 errors, 100 warnings (98 pre-existing; the 2
                                new ones are console.log in a new script, which
                                is what every other script in scripts/ does)
           npm test           — 3225 passed, 160 skipped, 0 failed
                                (baseline before this work: 3147 passed)
           npm run test:db    — 663 passed, 0 failed, against MySQL 8.4 with
                                the schema baseline and all 21 migrations
           npm run build      — dist/ + 21 migrations + pruned lockfile
frontend:  npm run check      — svelte-check clean, 723 tests passed
           npm run build      — rebuilt; public/admin refreshed
           npm run build:portal — rebuilt
           npx playwright test — 26 passed
runner:    ruff check .       — all checks passed
           pytest             — 174 passed
wrappers:  gofmt -l .         — clean
           go vet ./...       — clean
           go test ./...      — clean
```

No schema change, so no migration was added: the capability layer reads
`admin_users.access_level` and touches no table.

That is *not* a reason to skip the real-MySQL tier, and skipping it on that
reasoning was the one mistake in this pass that reached a remote. `npm test`
skips 160 tests without a database, and `test:db` is the only tier that builds
an app through `test/helpers/build-app.ts` — a helper that promises "the same
plugin stack as `src/server.ts`" and had not been given the capability plugin.
Its suites therefore ran real route modules with their old gates deleted and
nothing attached in their place, and `magic-link-e2e.test.ts` correctly failed:
a `viewer` reveal of an agent portal magic link answered 200 where it asserts
403. Production was never affected — `src/server.ts` registers the plugin, and
the matrix denies `agent_portal.reveal_link` to every read-only role — but the
tier that would have caught a real version of that bug was blind to it. The
helper now registers the plugin alongside `auth-admin`, and
`build-app-with-db.test.ts` pins both that the decorators exist and that the
`onRoute` refusal is live, so the harness cannot drift from the server again
without a red test. The tier is green: 663 passed.

One note on the browser suite: it logs ten Svelte `derived_inert` warnings
during the last two specs. They are **pre-existing** — verified by running the
same two specs against the committed `agent-messaging/+page.svelte` and getting
the identical count — and are not investigated here.

Not run: the compose-based end-to-end matrix, arm64 image builds, and the
optional live-provider smokes. The last need credentials, and nothing in this
pass touches a provider path.

---

## What was not committed

Nothing. No commit, no push, no tag, no release, no deploy, no production
restart, and no production migration. The work is an uncommitted diff on a
worktree that was clean at `13b4093f`; the one pre-existing stash entry was left
untouched.

---

## Earlier pass — snapshot `6c0866d3`

The first brief's remediation is recorded in this repository's history at
`eec621c9`…`13b4093f` and remains accurate: the `.env` build leak, image
pinning and non-root, engine-hint resolution, runner SSRF and input bounds,
generation-control refusal, honest stop reasons, and the CI gates that were
never running. Its outstanding list has been folded into the outstanding list
above rather than kept separately, since the second brief supersedes it.
