# Auth Runner (Sidecar) Behavior

The auth runner is a FastAPI sidecar (`auth-runner` in `docker-compose.yml`) that sanity-checks auth payloads, generates short skill/memory summaries, drafts new skill manifests, revises skill and project drafts from a conversation, and executes one-shot prompts by running `/usr/local/bin/codex` (or the Claude CLI) in an isolated temp `$HOME`.

## HTTP surface (runner container)

This is every route `runner/app.py` registers. `runner/test_docs_surface.py`
walks `app.routes` and fails when a registered `METHOD /path` is missing from
the list below, and when the list names a route the runner does not serve, so a
new route has to be documented here before it can ship.

- `GET /health` returns `status` (`ok` / `degraded`), `required_engines`, a `problems` list, and per-engine `available`, `binary`, `version`, `expected_version`, and `version_matches`. `available` means the binary resolved *and* answered `--version`; it is not a `which` lookup. Used by Docker health checks and by the API boot check, which reads each engine's entry on its own rather than the top-level `status` — one drifted CLI must not mark the other engine dead.
- `POST /verify` validates Codex credentials. Body: `auth_json` (required object) and `timeout_seconds` (optional float).
- `POST /verify-claude` validates Claude credentials. Same body as `/verify`. Native Claude Code OAuth/account-login payloads use the Claude CLI; genuine Anthropic API keys use the Messages API.
- `POST /skills/summarize` generates a short AGENTS-safe skill summary. Body: `auth_json` (required object), `slug` (required string), `manifest` (required string), optional `engine` (`codex` | `claude`, default `codex`), and optional `timeout_seconds`. **No API caller today:** nothing under `api/src` requests this route.
- `POST /memories/summarize` generates a short AGENTS-safe memory summary. Body: `auth_json` (required object), `memory_key` (required string), `content` (required string), optional `engine`, and optional `timeout_seconds`. **No API caller today:** nothing under `api/src` requests this route either.
- `POST /skills/generate` generates a structured skill draft. Body: `auth_json` (required object), `prompt` (required string), optional `slug_hint`, optional `engine`, and optional `timeout_seconds`.
- `POST /skills/assist` revises a structured skill draft from a conversation. Body: `auth_json` (required object), `messages` (required array), `skill` (required object), optional `mode`, optional `slug_locked`, optional `engine`, and optional `timeout_seconds`.
- `POST /projects/assist` revises a project roster draft. Body: `auth_json` (required object), `slug` (required string), `project` (required object), optional `engine`, and optional `timeout_seconds`.
- `POST /exec` runs one prompt through the engine CLI. Body: `auth_json` (required object) and `prompt` (required string), plus optional `images[]` (`url`, optional `detail`), `model`, `engine` (`codex` | `claude`, default `codex`), `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `system`, and `timeout_seconds` (default `30`). The runner still accepts `temperature`, `top_p`, `top_k` and `stop_sequences` on the wire, but **the API no longer sends them**: `api/src/services/transport-capabilities.ts` marks them `unsupported` for the CLI transport and both compat adapters refuse such a request with `400 unsupported_generation_control` before dispatch, rather than forwarding a control the CLI drops. `system` is forwarded on the `claude` path only. `max_tokens` is forwarded but labelled `accepted-unenforceable` — Anthropic's Messages API requires the field on every request, so refusing it would break the official SDK against this surface; nothing reports a `max_tokens` stop reason on this transport as a result.

  Every caller-controlled field is bounded: `prompt` ≤ 1,000,000 characters, `system` ≤ 100,000, `model` ≤ 200, `stop_sequences` ≤ 16 entries, `timeout_seconds` in `[1, 600]`, and `temperature`/`top_p`/`top_k`/`max_tokens` to their valid ranges. Image handling is bounded by `RUNNER_MAX_IMAGES`, `RUNNER_MAX_IMAGE_BYTES` and `RUNNER_MAX_IMAGE_TOTAL_BYTES` (see `runner/README.md`), the content must actually be a PNG/JPEG/GIF/WebP by magic bytes rather than by its declared MIME type, and remote downloads go through `runner/network_policy.py`: one DNS resolution, a socket opened to that exact approved address with the original `Host` header and TLS SNI, the connected peer re-verified before any bytes are written, only globally routable addresses permitted, no redirects, and `Accept-Encoding: identity` so the byte cap bounds real bytes rather than compressed ones.
- `RUNNER_SHARED_SECRET` is mandatory. Every POST — `/verify`, `/verify-claude`,
  `/skills/summarize`, `/memories/summarize`, `/skills/generate`,
  `/skills/assist`, `/projects/assist`, and `/exec` — requires
  `X-Runner-Auth` with an exact match; an unset runner secret fails closed with
  HTTP 500 and a wrong/missing request secret returns 401. The GET routes below
  and `GET /health` answer without the secret.
- `POST /verify` and `/verify-claude` probe responses include `status`,
  `latency_ms`, `reachable`, `definitive`, the engine version, and optional
  `reason`. Native CLI probes for BOTH engines run from a refresh-stripped
  credential file (Codex: `tokens.refresh_token` blanked; Claude:
  `refreshToken` removed — see the engine paragraphs below), can therefore
  never rotate the shared grant, and always report
  `auth_readback:"unchanged"` with no `updated_auth`; direct API-key probes
  use `not_applicable`. `/exec` and the skills/memories/projects endpoints run
  from the same refresh-stripped HOMEs — no runner endpoint ever holds
  spendable refresh material, and none returns `updated_auth`. A gateway
  request that lands while the canonical access token is expired therefore
  fails fast instead of silently spending the fleet's rotating refresh token;
  hosts heal the canonical within ~30 s via their mid-session upload watchers.
  A failed result is definitive only
  when the output explicitly identifies credential rejection; provider
  outages, quota/model errors, timeouts, and generic CLI failures remain
  retryable. Anthropic `rate_limit_error` proves the key and returns `ok` with
  `auth_limited:true`.
- `GET /skills/summarize`, `GET /memories/summarize`, `GET /skills/generate`,
  `GET /skills/assist`, `GET /projects/assist`, and `GET /exec` each return
  `{"status": "ok"}` so API-side readiness probing can hit the same route used
  for the matching POST.
- `POST /skills/summarize` success responses include: `status`, `latency_ms`, `reachable`, `codex_version`, optional `summary`, and optional `reason`.
- `POST /memories/summarize` success responses include: `status`, `latency_ms`, `reachable`, `codex_version`, optional `summary`, and optional `reason`.
- `POST /skills/generate` success responses include: `status`, `latency_ms`, `reachable`, `codex_version`, the structured draft fields (`slug`, `display_name`, `description`, `tags`, `what`, `when`, `steps`), and optional `reason`.
- `POST /skills/assist` success responses include: `status`, `latency_ms`, `reachable`, `codex_version`, `assistant_message`, the structured draft fields (`slug`, `display_name`, `description`, `tags`, `what`, `when`, `steps`), and optional `reason`.
- `POST /projects/assist` success responses include: `status`, `latency_ms`, `reachable`, `codex_version`, `assistant_message`, the structured draft fields (`title`, `name`, `description`, `roster_markdown`), and optional `reason`.
- `POST /exec` responses include: `status`, `latency_ms`, `reachable`, `output`, and `error` on failure — never `updated_auth` (exec HOMEs are refresh-stripped, so there is no rotatable lineage to read back). The `claude` engine also reports `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`.
- Every engine-aware route reports `claude_version` instead of `codex_version` when the request selects `engine:"claude"`.
- CLI probe `status` is `ok` only when the command exits `0` and stdout contains
  `banana` (case-insensitive); otherwise it is `fail`. A non-zero CLI exit alone
  is not a credential verdict.
- Error responses: HTTP `400` when no usable token exists and HTTP `500` for
  runner exceptions. Native Codex and Claude probe timeouts are returned as a
  normal non-definitive `status:fail` result while the temporary home still
  exists, so refreshed credential bytes (or an explicit readback error) cannot
  be lost; an unexpected timeout outside that lifecycle may still be HTTP 504.
  API-side runner HTTP errors are always non-definitive infrastructure failures.

## Probe lifecycle (runner/app.py)

1. Optionally persist the incoming auth to `/tmp/last-auth.json` (0600) only when all are true: `RUNNER_DEBUG_DUMP_AUTH=1`, `RUNNER_ALLOW_SECRET_DUMP=1`, and `APP_ENV!=production`.
2. Resolve the same credential native Codex will execute. Explicit `auth_mode:"apikey"` selects only top-level `OPENAI_API_KEY`; explicit `chatgpt` / `chatgptAuthTokens` selects only `tokens.access_token`. Without a mode, native inference selects personal-access-token/Bedrock first (unsupported by this runner), then a present top-level `OPENAI_API_KEY`, otherwise ChatGPT tokens. Unknown/unsupported modes or a missing selected credential return HTTP 400. Legacy nested/auths-only keys are normalized by the API to native `apikey` shape before this call, not reinterpreted by the runner.
3. Create a temp `$HOME` under `RUNNER_HOME_PARENT` (the bundled runner image sets this to `/dev/shm`), point `TMPDIR` / `TMP` / `TEMP` at a writable subdirectory inside that home, write `~/.codex/auth.json` with `tokens.refresh_token` **blanked to the empty string**, chmod 0600, and clean up the temp home after the probe. The key must stay present — codex's `TokenData` refuses to parse a ChatGPT token block without it (verified live: a deleted key makes codex send no auth header at all) — but an empty value leaves the probe nothing to spend, so it can never rotate the fleet's shared grant. A failed proactive refresh is non-fatal upstream: codex logs the error and proceeds on the still-valid access token.
4. Env for the probe: `CODEX_SYNC_BASE_URL` from runner env when set (otherwise `http://api`), plus `CODEX_SYNC_OPTIONAL=1` and `CODEX_SYNC_BAKED=0`.
5. Run `/usr/local/bin/codex exec --model <probe model> -s read-only --skip-git-repo-check -- "Reply Banana if this works."` with timeout `timeout_seconds` (or `8.0` when unset/falsey). The probe model comes from `RUNNER_CODEX_PROBE_MODEL` (default `gpt-6-astra`) and `--` keeps a prompt starting with `-` from being parsed as a flag. The probe passes no images; `/exec` builds its command with the same helper and inserts one `--image <file>` per image right after `--model`.
6. Report `auth_readback:"unchanged"` unconditionally: with the refresh token blanked, the CLI cannot rotate the credential, so any rewrite of the temp file carries no lineage and is never returned as `updated_auth`.
7. Compute `codex_version` from `/usr/local/bin/codex --version`; if that command fails, `codex_version` is `unknown`.

Claude OAuth verification mirrors that isolated-home lifecycle with
`~/.claude/.credentials.json` and the native Claude CLI, with one deliberate
difference: the probe home receives the credential **without**
`refreshToken`/`refreshTokenExpiresAt`. The canonical grant is shared with
every host's own Claude Code and Anthropic rotates the refresh token on every
refresh, so a probe-side refresh would race host-side native refreshes and a
replayed spent token gets the whole grant family revoked (the historical
daily fleet re-login). A probe therefore only proves the access token it was
given; the API never even requests a probe for a credential whose access token
has expired while its refresh token is still live — that state is served
as-is and heals when a host refreshes natively and re-uploads. Managed clx
sessions retain their 30-second foreground watcher, while the per-user
`cxx-agent` worker watches the same native digest every two seconds even after a
detached Claude daemon outlives its spawning wrapper. It submits changes through
the normal guarded `clx auth-upload` path; no runner receives the refresh token.
Genuine API keys use a
direct Anthropic request; only HTTP 401/`authentication_error` is a definitive
failure, while permission/model/server failures are not.
Claude credential selection is `claudeAiOauth.accessToken`, top-level API-key
aliases, nested `tokens` API-key aliases, then the derived `auths` entry.
`sk-ant-oat...` outside a non-empty native OAuth object is rejected.

## Skill summary lifecycle (runner/app.py)

1. Require `slug` and `manifest`; reject blank values with HTTP 400.
2. Reuse the same auth bootstrap path as `/verify`: require a usable token from `auth_json`, create a temp `$HOME`, write `~/.codex/auth.json`, and clean it up after the run.
3. Run `/usr/local/bin/codex exec` with a strict prompt that asks for exactly one short plain-text sentence describing what the skill is used for.
4. Sanitize the result into a single trimmed line (collapse whitespace, strip common bullet/quote wrappers, cap length) before returning it as `summary`.
5. `status` is `ok` only when the command exits `0` and a non-empty sanitized summary is produced; otherwise `status` is `fail` and `reason` includes trimmed stderr/stdout (up to 400 chars).

## Memory summary lifecycle (runner/app.py)

1. Require `memory_key` and `content`; reject blank values with HTTP 400.
2. Reuse the same auth bootstrap path as `/verify` and `/skills/summarize`: require a usable token from `auth_json`, create a temp `$HOME`, write `~/.codex/auth.json`, and clean it up after the run.
3. Run `/usr/local/bin/codex exec` with a strict prompt that asks for exactly one short plain-text sentence describing what the memory contains for admin/API summary display.
4. Sanitize the result into a single trimmed line (collapse whitespace, strip common bullet/quote wrappers, cap length) before returning it as `summary`.
5. `status` is `ok` only when the command exits `0` and a non-empty sanitized summary is produced; otherwise `status` is `fail` and `reason` includes trimmed stderr/stdout (up to 400 chars).

## Skill draft lifecycle (runner/app.py)

1. Require a non-empty `prompt`; reject blank values with HTTP 400.
2. Reuse the same auth bootstrap path as `/verify` and `/skills/summarize`: require a usable token from `auth_json`, create a temp `$HOME`, write `~/.codex/auth.json`, and clean it up after the run.
3. Run `/usr/local/bin/codex exec` with a strict prompt that requests exactly one JSON object containing `slug`, `display_name`, `description`, `tags`, `what`, `when`, and `steps`.
4. Parse the returned JSON strictly, sanitize the individual fields, and fail the request when Codex returns malformed or incomplete output.
5. `status` is `ok` only when the command exits `0` and the structured draft parses cleanly; otherwise `status` is `fail` and `reason` includes parse error details plus trimmed stderr/stdout (up to 600 chars).

## Skill assist lifecycle (runner/app.py)

1. Require a non-empty `messages` array and a `skill` object.
2. Reuse the same auth bootstrap path as `/verify` and `/skills/summarize`: require a usable token from `auth_json`, create a temp `$HOME`, write `~/.codex/auth.json`, and clean it up after the run.
3. Run `/usr/local/bin/codex exec` with a strict prompt that includes the current structured draft, the conversation history, and whether the slug is locked.
4. Parse the returned JSON strictly. Require `assistant_message`, `slug`, `display_name`, `description`, `tags`, `what`, `when`, and `steps`, then sanitize the individual fields.
5. `status` is `ok` only when the command exits `0` and the structured assist payload parses cleanly; otherwise `status` is `fail` and `reason` includes parse error details plus trimmed stderr/stdout (up to 600 chars).

## How the API uses it (`api/src/services/host-auth.ts` + `api/src/services/runner-client.ts`)

- Runner is enabled only when `AUTH_RUNNER_URL` is a non-empty string; otherwise the runner client is not created.
- API boot checks probe the runner's derived `/health` endpoint once for per-engine telemetry. Credential verification itself sends one `POST` directly to `/verify` or `/verify-claude`; transport/parse/HTTP failures are non-definitive and report `reachable=false` only for an actual transport/provider-unreachable signal.
- Runner request payload includes only `auth_json` and `timeout_seconds`. When `AUTH_RUNNER_SHARED_SECRET` is set, the client also sends `X-Runner-Auth`. The API HTTP transport allows an additional bounded six-second response/readback grace beyond the native probe deadline; this lets a timed-out CLI return any rotated credential bytes safely instead of losing them at the transport boundary.
- OpenAI-compatible `/exec` request payload includes `auth_json`, `prompt`, `images[]`, `model`, `engine`, `timeout_seconds`, and whichever of `max_tokens`, `temperature`, `top_p`, `system`, and `stop_sequences` the caller supplied; the Anthropic-compatible adapter can additionally send `top_k`. When `model` is present the runner invokes `codex exec --model <id> ...`, and each image is materialized to a temp file then passed through as `--image <file>`.
- Project assist request payload includes `auth_json`, `slug`, `project`, and `timeout_seconds`. The API uses it for the admin-only project roster draft flow (`api/src/services/project-drafts.ts`).
- `/skills/summarize` and `/memories/summarize` have **no API caller**: no code under `api/src` builds either URL or sends either payload. The routes are reachable on the runner but currently unused, so a summary only exists if something outside this repo posts to them.
- Skill draft request payload includes `auth_json`, `prompt`, optional `slug_hint`, and `timeout_seconds`. The API uses it only for the admin-only `POST /admin/skills/generate` draft flow; generated drafts are not persisted until the admin later calls `POST /admin/skills/store`.
- Skill assist request payload includes `auth_json`, `messages`, `skill`, optional `mode`, optional `slug_locked`, and `timeout_seconds`. The API uses it only for the admin-only `POST /admin/skills/assist` conversational draft flow; generated drafts are not persisted until the admin later calls `POST /admin/skills/store`.
- Every canonical-auth store path:
  - Every candidate that could update canonical auth requires a configured
    runner and a positive live verdict. With no runner, the request fails 503
    and no canonical pointer or served-host state changes.
  - If the runner is unreachable or returns a non-definitive failure without changing credentials, the update returns HTTP 503 and canonical state is unchanged.
  - If a timeout/non-definitive probe changed the credential file, replacement bytes may be retained as a quarantined `pending` lineage before the request fails with the wrapper-recognized unsafe-refresh code `runner_updated_auth_invalid`. If a probe changed credentials before a definitive rejection, the replacement is retained as quarantined `failed` history and the same unsafe-refresh 503 is returned. Neither state advances `auth_canonical_heads`, appears in an `auth` response, or feeds a compatible API gateway. Missing, unreadable, malformed, older, wrong-engine, credential-kind-changing, or refresh-token-losing replacement bytes fail closed and mark an already-selected old lineage unsafe where applicable.
    When an upload probe for the selected credential lineage changes the file
    before any non-OK final verdict, the transaction also marks that exact head
    failed if it is still selected: the shared access/refresh credential may
    have been consumed and is never served while the replacement waits in
    quarantine. An unrelated login or a different head that wins the
    post-probe compare-and-swap remains available.
  - A definitive provider-auth rejection with unchanged credentials returns HTTP 422. Generic provider/CLI failures never become credential verdicts.
  - If runner `updated_auth` omits `last_refresh`, it inherits the upload generation for validation. A supplied stamp must be RFC3339 and same/newer, and the payload must retain usable engine credentials. When its digest changes canonical auth without advancing that stamp, persistence assigns a bounded timestamp at least 1 ms after the selected lineage; it fails closed if no later millisecond fits below `now+300s`.
  - A present `updated_auth` must be structurally runnable, same/newer than the
    submitted generation, retain its credential kind, and preserve an existing
    OAuth refresh token. In particular, an empty Claude `claudeAiOauth` block
    cannot be rescued by a derived `sk-ant-oat` `auths` entry. Violations fail
    the store closed; the pre-refresh candidate is never stamped verified after
    the runner reports a changed credential.
  - Codex candidates are canonicalized to exactly one native mode before live
    verification: `auth_mode:"chatgpt"` with `tokens`, or
    `auth_mode:"apikey"` with top-level `OPENAI_API_KEY`. The opposite/shadow
    credential is stripped. Claude candidates receive the same single-selected
    credential treatment. For either engine, only its native derived `auths`
    target is retained in the canonical body and `auth_entries`; unrelated
    targets are never sent fleet-wide. A verified row is distributable only
    when its stored body is already byte-for-byte equal to this projection and
    its complete fingerprint metadata matches. The background worker bypasses
    its normal TTL for verified rows that need normalization or metadata
    reissue, probes the projected bytes, and promotes only a fresh verified
    replacement.
- `POST /seed/auth/{token}`, `POST /admin/auth/upload`, and `/sync/bootstrap` inline `auth_candidate` call the same runner-validated store path as host `/auth`, so runner `updated_auth` can become canonical there too.
- **Background launch-gate verification (both engines).** The API starts an
  auth-verification worker when `AUTH_RUNNER_URL` is configured. It wakes on
  boot and then every `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (default
  `300`) and re-probes each engine's canonical payload on a **dynamic
  schedule**: the re-check interval equals the time the credential has been
  proven good, clamped between `AUTH_RUNNER_VERIFY_TTL_SECONDS` (default
  `900`, the minimum) and `AUTH_RUNNER_VERIFY_MAX_INTERVAL_SECONDS` (default
  `21600`) — a factor-2 ladder (15 m → 30 m → 1 h → … → 6 h). A successful
  gateway exec with the canonical credential counts as proof and advances the
  same clock (see the compat gateways), so probes only fire when the fleet is
  idle. Pending quarantine rows and attempts that end without a persisted
  verdict (runner outage) retry on the same ladder instead of every tick, and
  a credential whose access token has expired while its refresh token is live
  is never probed at all (see the refresh-spend note above). A nominally
  verified row that is not safely distributable is still repaired
  immediately.
  `/auth retrieve` and the `/sync/bootstrap` candidate-match path do not call the
  runner inline; they surface the latest stored `verification_state`
  (`verified` | `failed` | `unknown`) plus optional `verification_reason`:
  - `verified` — token chain proved live by the worker or a strict store path;
    served normally.
  - `failed` — runner reached the provider and the credentials do not work; the
    known-bad blob is withheld and the wrapper refuses launch with a re-login
    prompt instead of a raw 401 (Claude) / `refresh token already used` (Codex).
    A probe that rotates credentials before definitively rejecting them retains
    the replacement as quarantined failed history. A successful probe that
    returned unusable replacement bytes, or whose refreshed writeback failed,
    instead marks the old lineage failed because it may already have been
    consumed.
  - `unknown` — runner not configured or unreachable; the response preserves the
    legacy digest-derived status and the wrapper keeps its offline/cached
    behaviour (a runner outage never downgrades a payload to `failed`).
    All canonical-changing work is queued per engine inside the API process.
    Worker/store probes for the same canonical payload are additionally
    single-flighted (keyed by engine + payload id) so a fleet of checks cannot
    race the refresh-token rotation into spurious `failed` verdicts. A final
    canonical compare-and-swap runs after each probe. When the runner
    refreshes the token during a worker probe, the refreshed blob is persisted as a
    fresh canonical (rotation-safe) and picked up by the next retrieve. After a
    stale live probe reaches the runner, the worker also updates the engine-scoped
    runner telemetry (`runner_last_ok[_claude]` or `runner_last_fail[_claude]`),
    so the admin runner card reflects the background auth-readiness check rather
    than only boot-time or manual checks.
- Successful `store` responses always include `runner_applied`,
  `verification_state:"verified"`, and verified canonical `auth`. Quarantined
  pending/failed payloads are internal history and are never returned as auth.
- The auth-verification worker is timer-driven, not request-driven; wrapper
  startup does not wait for stale canonical auth to be re-probed.
- Recovery behavior when `runner_state=fail`: the PHP `fail_backoff` path, which
  retried on boot-id change or ~15 minutes after `runner_last_fail`, was not
  ported; recovery now rides on the next boot check, timer pass or manual
  trigger. Recovery failures are logged; they block new stores but do not
  invalidate a still-current verified head.
- Manual trigger `POST /admin/runner/run` forces one Codex verification pass and
  `POST /admin/runner/run-claude` one Claude pass. Both take **no request body
  fields**; a body carrying the retired `prompt` / `model` / `reasoning_effort` /
  `preview` / `timeout_seconds` keys is rejected with `422 validation_failed`
  rather than accepted and ignored.
  Both run the *same* `ensureServedVerification` pipeline as the background
  worker and the `/auth` store path (`forceLive`, TTL 0), so a token the runner
  refreshes during the check is normalized, structurally validated, promoted
  under a compare-and-swap against the canonical head, and encrypted — or
  quarantined when it cannot be used. The trigger used to probe the runner
  directly and discard `updated_auth`.
  The response carries `engine`, `verdict` (`verified` / `failed` / `unknown`),
  `applied` (canonical head replaced), `probed`, `canonical_digest_before`,
  `canonical_digest`, `canonical_last_refresh`, `payload_id`, `detail`, and —
  only when a live probe actually ran — `reachable` and `latency_ms`. An absent
  `reachable` means "not probed", not "unreachable". No credential bytes are
  ever returned.
  Claude Code OAuth/account-login payloads are checked with a native Claude CLI
  probe instead of treating the OAuth access token as a public Anthropic API key.
- Runner telemetry stored in `versions`: `runner_state`, `runner_last_ok`, `runner_last_fail`, `runner_last_check` (set only when the runner request was reachable or a background auth probe produced a final provider verdict), plus the Claude-suffixed equivalents. Those four are the whole set — there is no boot-id or preflight marker.

## Network and IP notes

- Runner-originated requests can bypass host-IP rebinding when `AUTH_RUNNER_IP_BYPASS` is truthy (`1`, `true`, `yes`, `on`) and caller IP matches a CIDR in `AUTH_RUNNER_BYPASS_SUBNETS`; those requests are logged as `auth.runner_ip_bypass`.
- Code defaults: `AUTH_RUNNER_IP_BYPASS=0` and `AUTH_RUNNER_BYPASS_SUBNETS=''`. Compose/.env defaults keep bypass disabled unless explicitly enabled.
- Disabling runner (`AUTH_RUNNER_URL` empty/unset) reports
  `runner_enabled=false` in version snapshots. All host, admin, seed, and
  bootstrap stores return 503 without changing canonical auth until the runner
  is restored; existing verified heads remain readable.

## Configuration quick reference

Every `(runner container)` entry below is one env name `runner/app.py` reads.
`runner/test_docs_env.py` derives those names from the `os.getenv` /
`os.environ.get` literals in `runner/app.py` and fails when this list misses one
or names one the runner does not read, so a renamed knob has to be documented
here before it can ship. The `(API)` entries are read by the API process
instead.

- `AUTH_RUNNER_URL` (API): runner endpoint URL used for readiness GET + verification POST. Code default: empty (disabled). Compose default: `http://auth-runner:8080/verify`.
- `AUTH_RUNNER_SKILL_SUMMARY_URL`, `AUTH_RUNNER_MEMORY_SUMMARY_URL`, and `AUTH_RUNNER_SKILL_GENERATE_URL` (API): historical overrides. No API code reads them; setting one changes nothing.
- Skill generate, skill assist, and project assist endpoints are derived from `AUTH_RUNNER_URL` by replacing `/verify` with `/skills/generate`, `/skills/assist`, and `/projects/assist`; the `/exec` endpoint is derived the same way. The summary endpoints are not derived at all, because the API never calls them.
- `AUTH_RUNNER_TIMEOUT` (API): native provider/CLI probe timeout passed to the verifier payload. The API verifier HTTP request adds a fixed six-second readback/response grace. Default probe timeout: `8` seconds.
- `AUTH_RUNNER_CODEX_BASE_URL` (API): legacy compatibility setting retained in config/setup flows; runner verification no longer sends a `base_url` field.
- `AUTH_RUNNER_SHARED_SECRET` (API): when non-empty, API includes `X-Runner-Auth` in runner requests.
- `AUTH_RUNNER_PREFLIGHT_SECONDS` (API): legacy preflight interval retained for old deployments. Default: `28800` (8h).
- `AUTH_RUNNER_VERIFY_TTL_SECONDS` (API): minimum probe interval for the background verifier's dynamic schedule. Default: `900` (15m). Within the window a prior `verified` or `failed` verdict is always trusted.
- `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (API): background verifier wake-up interval. Default: `300` (5m), minimum effective interval 30s. A wake-up only probes when the dynamic schedule says a re-check is due.
- `AUTH_RUNNER_VERIFY_MAX_INTERVAL_SECONDS` (API): ceiling for the dynamic probe schedule. Default: `21600` (6h). The re-check interval grows with how long the credential has been proven good; successful gateway traffic also counts as proof and advances `runner_last_check*` without a probe.
- `AUTH_RUNNER_IP_BYPASS` / `AUTH_RUNNER_BYPASS_SUBNETS` (API): controls runner CIDR IP-bypass behavior in host authentication.
- `CODEX_SYNC_BASE_URL` (runner container): used by runner probe process; fallback in runner code is `http://api`.
- `RUNNER_HOME_PARENT` (runner container): parent directory for isolated temp homes used by runner Codex calls. The bundled image sets this to `/dev/shm`.
- `RUNNER_CODEX_PROBE_MODEL` (runner container): model passed as `--model` to the Codex "Reply Banana" probe. Code default: `gpt-6-astra`; a value that is blank after trimming drops the flag and lets the CLI pick.
- `ANTHROPIC_API_BASE` (runner container): base URL the direct API-key half of `POST /verify-claude` posts to. Code default: `https://api.anthropic.com`, with trailing slashes stripped.
- `RUNNER_SHARED_SECRET` (runner container): validates incoming `X-Runner-Auth` for every POST — `/verify`, `/verify-claude`, `/skills/summarize`, `/memories/summarize`, `/skills/generate`, `/skills/assist`, `/projects/assist`, and `/exec`.
- `RUNNER_DEBUG_DUMP_AUTH` + `RUNNER_ALLOW_SECRET_DUMP` (runner container): both must be `1` to allow `/tmp/last-auth.json` writes; still disabled when `APP_ENV=production`.
