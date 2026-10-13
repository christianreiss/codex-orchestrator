# 2026-10-13

- cxx 0.9.78 stops a managed Codex launch from reading `/skills` twice, the second time on its critical path. Before the communicator the launch listed skills in parallel with the content bundle and reused that listing; in managed mode the prefetched listing was discarded and the shared `skills` operation ran inline after authentication, one more sequential round trip (1.2 s at the production database latency of about 100 ms per statement). The managed launch now skips the unused prefetch and starts the shared skills operation as soon as the first bundle has been applied (it shares the scope gate with the bundle, so starting it earlier would delay the bundle), so it overlaps account selection and session start and the launch only joins its result. Measured with real handlers and +100 ms per SQL statement: a warm Codex launch reaches the native exec in 9.5 s against 10.7 s before this change and 9.1 s before the communicator. A launch that needed more than one bundle round (approval, upload, login) still asks again inline, since the early result is only as new as the first round. Claude and Grok already read skills once on this path.

- `cxx communicator status` / `doctor` now say why a server has no usable local socket. A runtime directory the wrapper refuses (for instance `XDG_RUNTIME_DIR=/run/user/0` leaked through `su`, which is not private to the user) used to print `{"running":false,"socket":""}` with no reason; the line now carries `"error"` with the refusal, and `doctor` fails for it.

- cxx 0.9.78 preserves numeric MCP IDs and result values when writing stdio replies, including integers beyond the exact `float64` range. Single and batch replies no longer round IDs after validating their correlation.

- Communicator frame limits count UTF-8 wire bytes, including non-ASCII headers, so an oversized encoded reply returns a correlated failure instead of exceeding the receiver limit and dropping the shared connection.

- cxx 0.9.78 rejects contradictory MCP replies containing both `result` and `error`, returning the existing correlated unknown-outcome error instead of forwarding an ambiguous result. A lone `result: null` remains valid.

- Communicator frame limits count UTF-8 wire bytes, including non-ASCII headers, so an oversized encoded reply returns a correlated failure instead of exceeding the receiver limit and dropping the shared connection.

- cxx 0.9.78 rejects contradictory MCP replies containing both `result` and `error`, returning the existing correlated unknown-outcome error instead of forwarding an ambiguous result. Error replies must also contain an object with an integer `code` and string `message`; malformed errors retain unknown-outcome handling without replay. A lone `result: null` remains valid.

- Codex and Claude can recover an interrupted credential upload when a readback supplies a strictly newer verified canonical head for the same account. Recovery uses the existing generation-guarded session writer, preserves concurrent native rotation/logout, and reports adoption without replaying the upload. Equal, older, unverified or wrong-account heads remain unresolved.
- A launch's own bootstrap now satisfies the communicator's pending content pass for its scope instead of being followed by an identical one. Opening a scope that the owner had not seen registered it, which made the scheduler's initial content pass due; that pass queued on the scope's gate behind the launch's bootstrap and repeated the same bundle exchange (`/wrapper/v2/config` plus a second `/sync/bootstrap`), while the launch's gated `/auth` waited for it. In the Claude fixture replaying measured production route latency, a cold launch took 13.1 s before and 7.1 s after (not a production or all-engine timing claim); the repeat sometimes landed in the next launch instead. A scheduled content pass is now skipped when a complete bootstrap/content worker for the scope started after the last server invalidation (a pushed `invalidate` frame or a reconnect, stamped on arrival) and less than five minutes ago, and its deadline moves to one period after that exchange; a first connection counts as no invalidation, and a new scope's first scheduled pass waits 1.5 s so the session that opened it runs first. Explicit syncs, `auth` operations and bootstraps that carry auth are never skipped, and scheduled passes no longer share a coalescing key with explicit `content` callers. Regressions run the real binary against a stub API with a 300 ms connection delay and fleet-shaped content (`startup_profile_test.go`, which also holds the opt-in `CXX_STARTUP_PROFILE=1` stage profile).

- The cxx MCP stdio adapter (`cxx communicator mcp`) now exits on SIGTERM even when the native client keeps stdin open; in-flight requests still report an unknown outcome first. It forwards JSON-RPC batches and returns the server's array reply, instead of exiting with "invalid MCP JSON" and dropping replies still in flight. Notifications in a batch get no reply, an unparsable line now gets a `-32700` parse error while the session continues, and the API's `-32600` answers to invalid input without an id (such as `[5]` or an object missing `method`) are passed through instead of dropped. After SIGTERM, including one that arrives after stdin has closed, the adapter waits at most three seconds for pending replies, so a client that stopped reading stdout cannot keep it alive. Replies are relayed byte-exact, so integer request IDs beyond 2^53 are no longer rounded on stdout.

- cxx 0.9.78 stops a hung API from holding a command for the whole connection budget. A request that finds no control connection used to wait up to 20 s for the first connect, and every further call waited again, longer than the 15 s the credential sync worker is allowed. Measured on a harness host behind a TLS proxy with the API process stopped (TCP accepted, no answer; the host is insecure with no cached auth, so every run ends `blocked` with "API offline", before and after): on a cold owner `cdx sync` took 30.6 s, `clx sync` 16.3 s and a repeated `cdx sync` 15.7 s; after an established outage 15.7 s, 15.9 s and 15.8 s. The first-connect budget is now 10 s and a redial after a lost connection gets 3 s, both shared by every request during one connection attempt, so only the first call of a command pays it: cold owner 11.4 s / 1.3 s / 1.3 s, established outage 4.3 s / 1.2 s / 1.4 s. `cgx sync` stays at 31-34 s (was 46 s) because its request is already on the wire and waits for the client's own timeout, not for admission. The same wait also left a stale credential-upload marker: the worker writes `.cxx-communicator-pending-auth.json` before it asks for the connection, so a worker killed at 15 s while its request still waited (nothing sent) kept the marker and reported an unknown outcome, and every later launch then refused to start until the marker was deleted by hand. A real owner and worker process against an API that accepts TCP and never speaks now finish in 10.2 s with a definitive `503`, no marker and the local credential untouched (the same test on the previous code: killed at 15.0 s, marker left); a frame that was delivered and never answered still ends with the marker kept and an unknown outcome. A request whose connection had already ended before it was written is answered `503 communicator_unavailable` (provably not sent) instead of `409 communicator_outcome_unknown`; a frame that was written and then lost stays unknown. An API that refuses or answers 5xx is unchanged (about 1 s), and recovery after the API returns stays about 1-2 s.

- cxx 0.9.78 routes Codex and Claude commands through the communicator immediately after signed config recovery or custom `--config` selection. Previously commands outside the native lifecycle, including `status` and auth helpers, could send control requests directly because early discovery had skipped the expired or non-default file. Grok already binds before dispatch; real-process regressions cover both startup paths for all three engines.

- cxx 0.9.78 keeps the server's verdict on a host's credentials when the communicator cannot connect. A refused handshake used to become a retryable `503 communicator_unavailable` for every local request, so a revoked key, an unbound IP, an expired temporary host or a disabled host looked like an outage: the wrappers' clients retried it and bridged it with cached auth, and `Grok`/agent-bus classifiers that act on 401/403 never saw it. A request that never reached the control channel now gets the server's own `401`/`403 host_*` status and body (header `X-Cxx-Communicator-Refusal: handshake`), exactly as direct HTTPS answered; a switched-off communicator, the API kill switch, 5xx and dropped connections stay `503`, and an unknown outcome stays `409`. The verdict is dropped as soon as a later connection attempt succeeds or fails for another reason. Real Codex and Claude clients are tested through the owner (4xx is returned at once; a 503 is retried).

- The Live Topology page no longer infers that a connection from the same host and OS user is a communicator coming back, because separate runtime roots can host distinct owners for one user. The owner now names itself in its negotiated `capabilities` frame (`instance_id`: a per-process UUID; `runtime_id`: a hash of its local socket path), and a disconnected connection is linked to a later one only when the same process dialled again (`same_process`) or a different process announced the same runtime (`same_runtime`). Otherwise the page lists an unverified candidate, and an owner that predates the identity fields can only produce candidates. Mixed versions are unaffected: old servers never announce control, so a new owner never sends the frame.

- cxx 0.9.77 keeps the shared communicator available when its original engine config is removed, suspended or disables the transport. Reconnect and owner replacement select another verified engine config for the same host and server, including active sync scopes, and HTTPS transfers adopt that policy. Missing or foreign configs never permit a downgrade; an explicit signed rollback still does.

- cxx's communicator owner can now be stopped from the console as a real process, with the proof the server actually has. The server offers `control: ["terminate"]` in `ready`; an owner that sees it describes itself once (`capabilities`: pid, start time, `instance_id`, `runtime_id`) and then honours a `terminate` frame addressed to that `instance_id` (a command for another process is refused with `owner_mismatch`). It acknowledges within a bounded write, admits no new local work from then on, lets in-flight local requests drain for up to three seconds, and exits through the idle-exit path; a repeat of the same request is answered but acted on once. `POST /admin/communicators/{id}/terminate` (`agent_portal.manage`, audited as `communicator.terminated`) reserves its `client_message_id` before awaiting anything, so concurrent duplicate clicks dispatch once, and reports `acknowledged_closed` (the addressed process acknowledged and its connection closed), `acknowledged`, `unacknowledged` or `refused` — never an exit, which the server cannot observe, and never from a frame that was merely sent or an acknowledgement from a different process. The console says "Stop accepted, connection closed" and states that this is not a confirmed exit. Old owners and old servers are unaffected, and an owner that did not announce the capability is not offered the control. A surviving client starts a new owner, which the page shows as a different process.

- Owner identity in the remote-stop control is now negotiated separately. The server announces `control: ["terminate", "owner_identity"]`; an owner that sees `terminate` without `owner_identity` (a server whose strict `capabilities` schema predates identity) sends only the legacy fields with `terminate: false`, never `instance_id`/`runtime_id`, and ignores terminate frames from it, so a mixed-version pair degrades to disconnect-only instead of having its connection rejected. A new owner against a server that announces neither token still sends nothing.

- Two boundary fixes in the console's communicator controls. A `client_message_id` whose operation is still running is never evicted from the idempotency ledger, so a retry cannot dispatch a second time even when many other controls are in flight; only settled entries are dropped to bound memory. And once an owner has accepted a stop, a second stop for the same connection is refused as `communicator_terminate_in_progress` (for 15 s, or until the connection closes) instead of sending the draining owner a second command. The stop button's caption now says what the result will say: an acknowledgement and a closed connection, not a confirmed exit.

- cxx 0.9.76 compares MCP request IDs by their JSON value, including escaped strings and equivalent decimal/exponent spellings, while keeping distinct large integer IDs separate. Grok now treats `409 communicator_outcome_unknown` as a transport interruption and retains its native session; actual auth revocation remains fatal.

- Oversized communicator replies preserve unknown write outcomes: auth-bearing bootstrap and session admission are never repeated over HTTPS, and completed mutations return `409 communicator_outcome_unknown` instead of a retryable 502. Content-only bootstrap and known reads retain their large-reply transfer path.
- cxx 0.9.75 marks oversized completed MCP replies as unknown outcomes and asks callers to verify the result before retrying, preserving the original request ID and work identifiers.

- The console has a **Live Topology** page (`/topology`): the server at the centre, each connected communicator on a ring around it, and the agent sessions it demonstrably carries on the rings beyond, updating live over the admin WebSocket (radial and list views, search, zoom and pan, keyboard navigation, reduced-motion aware). A session hangs off a communicator only when the API answered one of that session's own requests over that socket within the presence window (`GET /admin/topology`); otherwise it is shown as direct. Host, user and engine are never used to guess a parent. A communicator can be disconnected from the page (`POST /admin/communicators/{id}/disconnect`, `agent_portal.manage`, audited as `communicator.disconnected`): this closes that one socket with code 4001, lists the sessions it carried, and is reported as a transport reset, because the owner process keeps running and redials within 1–30 s. Agents are stopped through the existing cooperative close, force close and host-daemon stop contracts, each behind a confirmation naming the exact target.

- cxx 0.9.75 recognises the bakery's canonical wrapper binary URL (`/wrapper/v2/bin/<artifact>/<os>-<arch>/v<version>/<name>`) as a wrapper download: it streams over direct HTTPS instead of control frames, and stays reachable when no communicator owner can start, so `cxx update` can install a fix. The unused `/wrapper/v2/meta` no longer bypasses a broken owner.

- cxx 0.9.75 no longer makes every new session wait behind a forced resync of all engines: a communicator lease now schedules an initial pass only for a scope it newly registers, and never resyncs other scopes (a fresh per-session Grok runtime scope no longer resyncs warm Codex/Claude scopes). Previously each launch (and each session auth watcher) reset auth and content deadlines for every scope, so on a busy host the launch's own startup bootstrap queued behind several 4–8 s background workers (measured 8.7–16 s `clx sync` on a host with 24 sessions).

- cxx 0.9.75 also ends a host-daemon stream whose relay is blocked on a stalled local reader when the shared control connection drops or the server closes the daemon (not only on queue overflow), so the daemon notices and reconnects instead of hanging on a dead stream.

- cxx 0.9.75 also stops a host-daemon stream whose local reader has stalled: detaching it expires that stream's socket deadlines, so a relay blocked writing to it no longer keeps the stream (and its 64 queued events) alive.

- Managed MCP renders `cxx communicator mcp` only when that engine's wrapper version is a bakery cxx release at or above 0.9.71. Date-versioned shell wrappers (`2025.11.03`, `2025.11.3`), `dev`, and other non-releases stay on the HTTPS MCP endpoint. `v0.1.0` is a real version and stays on HTTPS because it is older than 0.9.71.

- cxx 0.9.76 hardens the long-socket-path fallback: the limit is each platform's own (107 bytes on Linux, 103 on macOS/BSD) so every path that binds keeps its place next to older owners, the fallback under `/tmp/cxx-<uid>` is keyed by the resolved runtime scope as well as the server (two different deep `XDG_RUNTIME_DIR`s no longer share one owner, fence and credentials, and neither can attach to the default short-scope owner), no stray long directory is created, a deep `TMPDIR` with no XDG scope still binds, and the startup error shown from `serve.log` is bounded and stripped of control characters.

- Communicator API (server): downloads, wrapper artifacts, attachments, watchdog streams and connect paths are now refused before dispatch on every equivalent path form (trailing and repeated slashes, queries), mirroring the owner's own transfer predicate. A frame can no longer make the router buffer and base64-encode a 17 MB binary or an attachment (up to 128 at a time per connection); the refusal is a correlated `400 communicator_path_forbidden` and the socket keeps serving. Counter-backed test: 150 refused transfer frames, zero dispatches, in-flight budget intact.

- Communicator API (server): a fault after a request was handed to the router no longer turns into a retryable 500 for writes. The reply is `409 communicator_outcome_unknown` for anything that may have changed state (a read keeps a retryable 5xx), a failure of the topology bookkeeping can no longer replace the reply of a request that already ran, and the reply cap now also measures the whole encoded frame (base64 body, headers, JSON; 15 MiB against the wrapper's 16 MiB limit) instead of only the payload. Counter-backed tests cover a throwing dispatch with a concurrent unrelated request, the bookkeeping fault, an oversized-header reply and host-scoped invalidations for two distinct hosts plus a fleet-wide event.

- cxx 0.9.76 explains a refused launch caused by an unconfirmed credential upload. When the communicator's pending-auth marker exists and the server's head differs from the local credential, Codex and Claude launches stay refused (nothing is replayed or overwritten blindly) but now say why, name `.cxx-communicator-pending-auth.json` and how to resolve it, instead of the opaque "Auth unavailable; refusing to start". Deleting the marker after comparing the credentials resumes normal sync immediately (verified live: the host then adopts the newer server head).

- cxx 0.9.76 makes a refused communicator connection diagnosable. The WebSocket library reported every refusal as "bad status", so a host whose IP binding no longer matched (a DHCP renewal or reboot) looked merely "API offline". The owner now asks the server why, records e.g. `communicator handshake rejected: HTTP 401 ip_mismatch (API key not allowed from this IP)` in `last_error` and in the `503 communicator_unavailable` message, and the wrapper prints its usual "IP binding mismatch ... use Release IP binding" guidance. Verified on a clean VM: after the reboot the owner and host daemon reconnect within 5 s of the binding being released, without a restart.

- cxx 0.9.76 fixes an idle-shutdown deadlock: after five idle minutes the communicator owner cancelled its loops but kept its Unix socket open and its lock held, so every later managed call got `503 communicator_unavailable` from a zombie that no client would replace (SIGTERM was ignored, only SIGKILL helped, and cron runs failed until then). The owner now closes its server on idle as well as on termination and the next call starts a fresh one.

- cxx 0.9.76 makes server outages cost what direct HTTPS does and recovery immediate: a request that finds the control connection down redials at once and waits for that single attempt instead of sitting out the 20 s wait or the up-to-30 s reconnect backoff; a failure from the last second is reported without redialling. Measured with the API stopped: a `cdx` launch went from 1 m 28 s and exit 1 ("final credential sync failed ... upload outcome unresolved", with a stale pending-auth marker) to about a second and exit 0; Claude MCP health from 20 s to under a second.

- Communicator startup (cxx): the local socket path is kept within the 108-byte `sun_path` limit by falling back to a private `/tmp/cxx-<uid>` directory when a long `XDG_RUNTIME_DIR`/`TMPDIR` would make the bind fail, and the owner's startup error is written to `serve.log` beside the socket and shown by the failing command. A communicator that dies while starting is reported at once instead of after ten seconds as "failed to start".

- cxx 0.9.75 keeps one host's communicator sync on that host: `host.*` events with a numeric `id` or `host_id` invalidate only the matching connection, and events that name no host still reach every connection. A reply above 11 MiB returns `502 communicator_response_too_large` for that request and leaves the shared socket open. Idempotent reads retry once over the communicator's HTTPS transfer; completed writes become `409 communicator_outcome_unknown`. Trailing slashes on the local route check match the API router, so `/watchdog/stream/` uses the flushing transfer and `/mcp/` keeps the signed host-key binding.

- Communicator daemon reattachment waits until the previous stream's remote disconnect has been sent, so delayed cleanup cannot disconnect a replacement daemon. Other engines keep using the shared control connection during this handoff.

- cxx 0.9.74 keeps large communicator transfers and signed HTTPS fallback bound to the same host as control traffic: managed routes only, no cookies or forwarding headers, and same-host MCP credentials. Reconnect adopts rotated signed host keys and TLS configuration for independent transfers while native sessions stay running. Unsafe local socket setup now fails closed instead of bypassing the communicator.

- cxx 0.9.74 preserves unknown call outcomes through the managed MCP adapter, including the original request ID, HTTP status and bounded machine code. Lost or invalid replies instruct callers to verify the result before retrying with the original work identifiers; malformed replies produce a correlated error instead of leaving the client waiting.

- cxx 0.9.74 keeps the communicator self-repairable: when no local owner can start or be reached, the signed config refresh and wrapper update downloads fall back to direct HTTPS (both are signature/digest verified), so a broken owner no longer blocks capability rollback or `cxx update`. Downloads and attachments no longer wait up to 20 seconds for a reconnecting control connection.

- The communicator dispatcher applies its route deny-list and MCP credential pinning to the pathname the router dispatches, so a trailing slash can no longer reach a watchdog stream through the shared connection. A malformed or disallowed request frame now gets its own 400 reply instead of closing the connection for every engine.

- cxx 0.9.74 detaches only a stalled host-daemon stream when its event buffer fills, instead of closing the shared communicator connection and turning every engine's in-flight requests into unknown outcomes.

- cxx 0.9.74 keeps one communicator per user when a launcher drops `XDG_RUNTIME_DIR` (Codex MCP servers, cron, non-login shells): the socket and sync fences fall back to `/run/user/<uid>` before `/tmp`, so a second owner no longer splits connections, status and auth fences.

- Communicator forwarding now includes provider-account lease acquisition, heartbeat and release, preserving native launches for all three engines over the shared connection.

- cxx 0.9.73 adds opt-in communicator sync ownership: finite engine workers, concurrent content coalescing, native credential watches, post-commit auth invalidations and per-scope status. Existing Codex/Claude auth arbitration and Grok server-owned refresh remain intact. Running sessions no longer pause managed content sync; signed rollback hands auth polling back without restarting native sessions. Unknown uploads retain digest-only recovery state and require readback before replay.

- cxx 0.9.72 adds a shared per-user CoCo communicator for Codex, Claude and Grok: a protected local socket, one multiplexed WebSocket, managed MCP stdio adapters, push-triggered content sync, reconnect/crash recovery and host connection status. The server capability is opt-in through `CXX_COMMUNICATOR_ENABLED`; existing account leases, native auth ownership and durable work acknowledgements remain authoritative.

- Dashboard provider accounts now share card spacing, quota meters, status badges and update footers, with three desktop columns and responsive tablet/mobile layouts. ChatGPT window labels follow the reported duration; a supplied 5-hour reading (including 0%) appears, while weekly-only snapshots no longer show an empty short-window placeholder.

- Wrapper 0.9.70 gives the bare-`cxx` launchpad an Obsidian compass: dark engine cards, fine animated light edges, directional paths, segmented effort selection and cached weekly usage bars. Responsive viewports keep selection visible during resize and long catalogs; input never waits for animation. Set `CXX_REDUCED_MOTION=1` for a still interface. ASCII, minimal and no-color output remain supported; launch/auth behavior is unchanged.

- Host details now use Overview, Settings and Operations tabs with compact status facts and grouped switches. Model/version overrides expand when set; remote-session settings and per-engine housekeeping use compact editors that retain drafts across tabs.

- Android 0.4.18 removes the separate Needs you filter and shows important, critical and blocker notices as highlighted messages in the regular chat timeline, with inline Resolve actions and retained resolved history. Unread reply counters are red for unresolved important notices and green otherwise. Chats with unresolved notices remain in All even when offline or ended; older notices outside the loaded tail appear once from the existing overview.

# 2026-10-12

- Wrapper 0.9.69 updates cxx first, then checks and installs Codex, Claude and Grok concurrently during manual `cxx update`. A shared terminal progress block keeps engine rows stable, shows measured download bars with transfer labels, and marks completed installs as waiting for sync. Credential guards, content/auth sync and version reports stay sequential; partial failures remain visible and cancellation joins workers before cursor/lock cleanup. Minimal, redirected and dumb-terminal output remains plain.

- Wrapper 0.9.68 adds compact weekly usage notices to the bare-`cxx` quick-select compass (and single-engine picker), using observations cached during verified account sync without network calls or credential storage. Notices show used percent, mark readings older than 30 minutes as stale, hide expired/reset or unavailable readings, and highlight fresh usage at 85%/100%. Cache reads stay scoped to the engine, fleet, native home and last synced account; Grok shows no weekly reading.

- Wrapper 0.9.68 makes the bare-`cxx` quick selector expand in the selected compass direction: the left engine opens a mirrored model/effort branch to the left, the bottom engine opens below a vertical stem, and the right branch keeps its existing layout. Animation, scrolling, Unicode/ASCII rendering and model/effort keys remain consistent.

- Wrapper 0.9.68 makes `cxx update` reconcile current signed host engine assignments before updating: enabling Grok (or Codex/Claude) after installation now adds its config and alias and installs/syncs its native CLI in the same run. Explicit host removal deletes managed configs and aliases while preserving provider binaries and user session data. Fleet-wide suspension retains installations; uncertain assignment probes preserve the existing layout, and cleanup failures return nonzero.

- Wrapper 0.9.67 stops printing `host daemon: daemon enabled: run 'sudo cxx daemon install' to install the system service` on every engine launch of a host that already has the service. An unprivileged launch now names the install step only while `/etc/systemd/system/cxx-daemon.service` is absent; an installed unit stays silent (refreshing its binary still needs `sudo cxx daemon install`, and root-run sync/cron does it automatically).

- Fixed `cdx`/Codex refusing to start with `invalid type: sequence, expected a map in shell_environment_policy.set`. Stored configs carried the legacy `set = []`, which was rendered verbatim into `config.toml`, but Codex requires `set` to be a map. The server now converts `KEY=VALUE` arrays into a map and drops any other non-map `set` when rendering, so every host heals on its next config sync with no stored-config edit and no wrapper update.

- Wrapper 0.9.66 and engine configuration now support validated native settings for Codex, Claude Code and Grok Build, with JSON editors, preview, granular ownership and atomic revision checks. Codex profiles expose native extensions; deprecated or wrong-scope settings fail visibly. Existing user-owned Claude/Grok settings survive synchronization. Native extensions require compatible CLI/wrapper versions.
- Engine catalogs and effort behavior match the audited native releases: deprecated GPT-5.5 selections migrate to GPT-6.1 Sol; Claude adds Haiku 5.5 and active Opus 4.6/4.5, migrates obsolete IDs, and writes model-specific effort preferences while keeping session-only `max` separate. Grok stable advances to 1.0.50 with verified package pins. Native CLI routing follows current command grammar. The [maintenance report](docs/engine-maintenance-2026-10-12.md) records evidence, feature decisions and external configuration boundaries.

- Wrapper 0.9.65 turns bare `cxx` into a launchpad on an attended terminal: one screen with Codex left, Claude right and Grok below the centre (only assigned engines; a single engine skips straight to its grid). An animated path leads into the chosen engine, where `↑`/`↓` pick the model and `←`/`→` the reasoning effort; efforts follow the highlighted model and snap to its default. `enter` starts a new chat, `c` continues the latest session in the directory, `r` opens the native resume picker (Codex/Claude). The last choice is remembered, so `cxx` + `enter` relaunches it. Launches go through the managed native path with the quota engine-switch prompt skipped; pipes and scripts still get usage and exit 2. Signed host configs now carry `engine_options.model_catalog` (the model-defaults catalog plus Claude's session-only `max`); older configs offer only the configured model. Grok prompts now use the Grok accent colour.

- Wrapper 0.9.64 resumes a planned Linux reboot in a detached, interactive tmux session when tmux is available to the original user. Local reboot status includes the attach command; Codex, Claude and Grok retain their exact native session and checkpoint, remote stop remains supervised, and explicit work receipts remain authoritative. Without tmux the existing headless continuation remains; tmux startup failure never launches a second continuation.

- Wrapper 0.9.64 fixes Claude sessions that stopped being woken by agent messages. A delivered informational message stayed held until the model called `agent_reply` or `agent_listen`; a model that read it and ended its turn otherwise left reception closed, so every later message, schedule wake and call queued until a human typed and "☎ calls waiting" appeared (24 of 117 Claude deliveries on biest waited over ten minutes on an idle session in one day). The `Stop`/`UserPromptSubmit` hooks now release informational deliveries the transcript shows were read, so the receiver pushes the next message and wakes the idle session; unread notifications, accepted work and Portal instructions stay held, and held work rings once with the tool that finishes it.

- Wrapper 0.9.64 closes the same latent gap for Codex and Grok, proven live on biest with fresh interactive targets: a model that answered with `agent_send` and ended its turn without `agent_listen` left the next message queued indefinitely. The receiver now treats a native thread that went busy after a submission and then stayed idle for ten seconds as having read it, and releases held informational deliveries so the next message, wake or call is submitted. Work and Portal instructions still need their explicit result.

- Removed the reserved `cxx remote` command family, which was never implemented. Wrapper 0.9.63 no longer has the `remote` verb, and signed host configs no longer carry `remote.enabled`. The `remote_exec_enabled` fleet switch, `GET`/`POST /admin/remote-exec`, the Policies toggle and the "Remote execution" section of served AGENTS.md/CLAUDE.md are gone too. Migration `0062` deletes the stored switch. Agents use ordinary SSH within their task authorization. Older wrappers ignore the absent field, and the new wrapper ignores it in configs that are still cached.

- Added the Docker-aware `bin/orchestrator` instance CLI: resumable setup, start, stop, readiness/status with JSON, and GitHub-main updates with private database/env backups, fast-forward checks, rebuilds, migrations and verified restarts. Setup and deployment share env-file/profile resolution and preserve the configured Caddy choice; stop retains containers and data.

- Android 0.4.17 adds a third Authorizations tab for waiting host-access requests and active host/fleet windows. Close actions reuse existing window services, audit the paired administrator/device, disable individual close during fleet access, warn about domain reopening, and require confirmation for fleet-wide closure. Approval pushes and Review next open the new tab; live refresh and offline action guards cover window changes.

- Wrapper 0.9.62 adds checkout-scoped agent discovery, excluding self, offline peers, other worktrees and hosts. Enabled Git Director instructions across Codex, Claude and Grok now require automatic task-worktree isolation for occupied/unknown checkouts, verified task commits even when alone, lease-coordinated merge-back and ancestry-gated cleanup. Dashboard/help document the agent-executed workflow; explicit restrictions prevail and push/deploy remain separate.

- Added the central Orchestrator Feedback inbox for agent bug reports, missing features and feedback, with MCP tools, exclusive renewable claims, versioned updates and verified-fix outcomes separate from deployment. The WebUI has triage/history and an activation switch; enabled fleets dynamically receive the workflow in Codex, Claude and Grok instructions.

- API builds reject malformed package manifests before writing artifacts, identify the offending file without printing its contents, and preserve existing build output on this failure.

# 2026-10-11

- Wrapper 0.9.61 and the API repair the independently verified Josefa audit findings. Native cancellation forwards INT/TERM/HUP with bounded cleanup; detached workers, gateway runner process groups, reboot receipts, failed-turn claims and expired receiver questions preserve their lifecycle contracts. SIGKILL recovery protects active transcripts, skill publication and Grok private runtime/auth material.
- Shared-memory compare-and-swap, transfer chunk append/retry, Git Director identity/leases and project claims now use atomic or fresh-presence checks. Host expiry/pruning and installer token transactions enforce their documented lifecycle across all engines. Cached quota retains its measured age on failed refresh; the worker drains on shutdown and Codex daily allowance rendering for 5-day and 7-day partitions and policy are restored.
- Concurrent Codex sync, observed fleet suspension, Claude fallback/settings ownership, Grok maintenance/login/config ownership, engine assignment and BrowserOS injection follow their intended contracts. Remote execution settings/help now disclose the unfinished command surface. Ordinary question notifications still require following, and missing Claude CLI installation remains intentional; stale documentation is corrected. The [audit report](docs/bug-audit/2026-10-11-triage.md) records every finding, classification, verification and remaining boundary.

- Android 0.4.16 caches recently opened active chat histories in encrypted, backup-excluded app storage. Saved messages appear immediately across chat switches and app restarts, then refresh from the server cursor. Cached content never grants send access or read receipts; reconnects update it, and ended/missing conversations, lost transcript access and unpairing remove it.

- Wrapper 0.9.60 reports native conversation activity for Codex, Claude and Grok independently of message reception and task results. WebUI and Android 0.4.16 show Working, Idle, Waiting for you or Unknown, including terminal-started work. Observations expire after 45 seconds; Claude hooks cannot conclusively observe every interruption, so long silent periods become Unknown. Additive migration 0060 stores the latest generation-fenced observation. Update the API before wrappers and clients.

- Wrapper 0.9.59 lets agents discover peers in their exact directory or Git project, including linked worktrees and clones across hosts. Managed Codex, Claude and Grok launches include a timestamped peer snapshot; scoped discovery reports tasks, presence and incomplete coverage for older clients. Session workspace metadata uses additive migration 0059 and does not require Git Director registration. Fleet guidance and its pinned digests now teach both scopes.

- Android Chats now limits All to online, active agents across engines, including working and idle clients. Offline, ended and read-only sessions are hidden from All without deleting retained history or changing Unread and Needs you.

- Active Clients separates ordinary agents from remote sessions while sharing the native conversation view. Remote work now has a searchable list, a start side panel, clear continuation states and retained retry drafts; host links open the same workspace. Fleet-wide agent session settings moved to Policies → Agent behavior.

- Android 0.4.15 and web Active Clients keep retained chats visible by default when an agent goes offline or ends. History follows the existing session-lifetime plus 24-hour server retention; sending still requires a reachable agent, and ended Android chats keep their badges cleared.
- Android chat displays outgoing messages immediately with Sending, then Queued and existing delivery receipts. Slow responses no longer leave an empty conversation; unconfirmed sends retain their bubble and draft with a Retry action that reuses the original request ID.

- Restored the complete validation gates: API fixtures apply the current migration chain without resurrecting retired Portal tables, and unchanged coverage thresholds run against the full MySQL suite. Browser checks use a fresh production preview and current Accounts, navigation, policy, quota and model-setting contracts while preserving the existing scenarios.

- File Transfer now uses the shared admin document title. Wrapper 0.9.58 is a validation-only rebuild: the reboot journal regression test now checks that a consumed request still reports a foreign cron file without retrying the native session.

- Destructive controls in dark mode now use readable text on a lighter red, fixing the Accounts delete button contrast failure. The shared theme regression checks enforce the same minimum contrast in light, dark and automatic dark modes.

- The Appearance menu preserves keyboard focus when overlapping autofocus callbacks finish during opening, preventing fast arrow-key navigation from jumping back to the first option.

- Android 0.4.14 gives agent conversations a messenger layout: green outgoing bubbles, inline photos with tap-to-open, quoted reply previews, long-press Reply/Copy, and a compact composer with camera and attachment sheet. Selected photos show thumbnails and upload progress; existing delivery receipts and send/retry contracts are preserved.

- Android media capture remains active when an incoming question switches the composer to button-only answers or back. Voice recordings and pending camera results keep their state across those prompt changes.

- Migration 0058 aligns rich-chat session IDs with existing Portal IDs on installations with mixed MySQL collations. This fixes failed chat snapshots and Android connections stuck on Reconnecting after the rich-chat upgrade, preserving chat data and device pairing.

- README features and the three-engine matrix now reflect current code, including Accounts, remote sessions, System Spawn, rich chat, recovery and housekeeping. Corrected API key namespaces, CLI examples and transport/security limits. Refreshed 16 documentation screenshots with a fictional fleet; capture now rejects unknown shots, missing API fixtures and page errors, and a helper regenerates all three terminal previews.

- Agent chat gains stable reply buttons and text/both answer modes, explicit important/critical/blocker Needs you notices with targeted resolution, and resumable images/files/audio/video in both directions. Android 0.4.13 and Active Clients add drafts, upload progress/retry/cancel, capture/playback, reply references and copy/formatting. cxx 0.9.57 exposes the shared chat/media MCP tools for all three engines; managed agent guidance explains their use. Installer and deploy prepare a private chat directory for the API/worker user. A local isolated media worker prepares timestamped Whisper transcripts and video frames; originals remain available on processing failure. Pixel installation is deferred.

- System Spawn installer retries after a timed daemon deadline repair all installed engines and report the expiry without attempting to reactivate the disabled daemon.
- cxx 0.9.56 waits within the five-minute reboot readiness deadline when early boot briefly falls back to an unbound IP family. It keeps strict IP binding and one-use native startup; invalid credentials still fail immediately. Grok checkpoints preserve the durable native home instead of a disposable auth runtime. The top-level CLI help now lists the reboot command.
- Android 0.4.12 prevents frequent live metadata updates from discarding every in-flight refresh, which left chats empty, replies unseen, sending unavailable and host cards stale. Completed snapshots are displayed before queued updates; permission changes, reconnects and conversation switches still reject superseded responses.
- Wrapper 0.9.55 fixes optional Linux host daemon startup: systemd now resolves the service user's home using `WorkingDirectory=~`, avoiding rejection of a quoted absolute path. Verified against Debian 13 systemd during the real System Spawn SSH test.
- System Spawn installer completion now uses the wrapper's IPv4-first connection policy, with a dual-stack fallback, avoiding rejected completion callbacks on secure hosts bound over IPv4. The callback also honours the installer's TLS policy.
- cxx 0.9.54 adds planned Linux reboot/resume: one host-wide boot hook, durable consume-before-start loop protection, exact native transcript resume for all three engines, transfer of accepted work, and linked reboot states in Active Clients. Managed agent guidance documents authorization, recovery conflicts, checkpoints and manual failure handling.
- System Spawn (off by default) lets active VIP hosts provision new non-VIP systems through MCP and install them over SSH. Setup defaults to secure, supports Codex/Claude/Grok, durable idempotent requests and renewable one-time installers. Optional permanent or timed Linux/systemd daemons enforce a fixed first-connection deadline, stop accepting new work at expiry and drain accepted work/results. Wrapper 0.9.53 persists deadlines locally across outages and restarts. Policies and host details expose the switch, provenance and expiry.

- Android 0.4.11 hides closed, failed and unknown daemon conversations from Chats. Ended conversations clear their unread counters and reply notifications; delayed pushes cannot restore those stale badges. Waiting conversations and unread replies during temporary connection loss remain available.

- Wrapper 0.9.51 defaults permanent daemon services and remote starts to the service user's home when no working directory is specified. Explicit request paths override configured defaults; native registration retains the resolved home for continuation. WebUI fields describe the empty default.
- Wrapper 0.9.50 adds configurable local session housekeeping for Codex, Claude and Grok: fleet defaults and host overrides, dry-run/status/pins, 30-day retention and a 5-GiB per-engine/user budget with a 7-day minimum age. Idle maintenance removes transcript bundles and associated history/search indexes, while preserving active, pinned, queued, goal and fleet-resumable sessions. Durable journals and launch fences make interrupted cleanup recoverable.

- Fresh-install Portal/daemon foreign keys use the canonical short migration names, avoiding MySQL identifier-length failures during baseline setup.

- Persistent daemons remain online with closed insecure access windows. WebUI and agents on active secure hosts can open windows; accepted running and retained waiting sessions renew them without resetting session timeouts. Manual Disable fences renewal, while stop/result receipts remain available. Wrapper 0.9.49 reports active processes and exposes `host_insecure_enable` for all three engines.
- New Host and setup registration offer an optional persistent daemon (default off, New Host shortcut 8), saving enablement before returning the installer while preserving existing daemon settings.
- Wrapper 0.9.48 uses the relay's IPv4 preference and CA trust for the host daemon WebSocket, fixing `401 ip_mismatch` on dual-stack hosts whose HTTP API calls succeed. TLS and WebSocket handshakes honor cancellation and a 35-second timeout. Enabled service installation/start now prints a confirmation during `cxx update`; remote connection health remains visible in `cxx daemon status` and the WebUI.

- Portal and Messaging preserve the same `peer_delivery` invocation kind during daemon resumes, preventing registration conflicts before native continuation.

- Android 0.4.10 adds Chats/Hosts navigation, searchable daemon-ready hosts and contact-only or task-based remote starts. Daemon launches remain one Portal conversation across native resumptions, with real agent replies, durable retry identity, inherited device follows and first-reply push. Companion routes enforce current device permissions, engine readiness and available work slots.
- Remote-conversation migration preserves the existing ID collations independently for older Portal and newer daemon/device tables, including upgrades with mixed collations.
- Daemon completion persists the native transcript proved by headless output so the next Android instruction resumes it; sessions lacking transcript proof remain unavailable for continuation.
- Wrapper 0.9.47 lets a daemon child use its parent's held native writer lock for the exact resumed transcript; unrelated wrappers and native identities still require their own lock.

- Wrapper 0.9.46 installs/starts enabled Linux host daemons during `cxx update`, wrapper sync/cron and Codex/Claude/Grok startup. Unprivileged runs show the required root installation step; accepted daemon work never restarts its parent service. Daemon connection and registration errors are visible in the journal.
- Host daemon readiness and admission use the current fleet Agent Messaging policy instead of the retired per-host messaging flag, fixing enabled hosts stuck at `host_access_blocked` despite working managed engine configs.

# 2026-10-10

- Wrapper 0.9.45 includes the Watchdog exit cause in the retried session-finish receipt. A clean exit or user interrupt atomically disables its Watchdog and cancels pending internal recovery, even if the standalone STOP report was lost. Accepted work, crash/capacity recovery and ordinary Wake/Cron schedules are preserved; delayed old-session receipts cannot stop newer protection.

- Wrapper 0.9.44 elects one automatic receiver per managed launch and forwards sibling MCP tool calls to its shared peer/Portal receipt tracker. Native subagents no longer create disconnected reply trackers or compete for reception. Update all MCP processes of a launch together; already accepted work is not replayed.

- Invalid route parameters, including Agent Messaging discovery limits outside 1–50, return `validation_failed` (HTTP 422) instead of an internal server error.

# 2026-10-09

- Removed the legacy `/go` mobile webchat, permanent magic links and portal-user management. Active Clients now holds shared agent-session settings and remote-session start/continue/stop controls. Android chat, notifications and wrapper receiver contracts remain available; cleanup 0051 deletes the retired portal access tables and their authored queue rows without converting identities.

- Chatty adds the personal bottom-right Admin assistant: verified AI access gating, private encrypted cross-device history, product/MCP knowledge, Codex/Claude/Grok selection, typed administration tools, concrete confirmations, cancellation and global Clear. Host-work dispatch stays outside Chatty; interactive credential flows link to the existing UI.

- Web Chat and Android 0.4.9 show per-message delivery, explicit AI read/working receipts and correlated replies. Wrapper 0.9.43 adds `agent_receiver_status`; queue acceptance never fabricates reading, and stale or unrelated turns cannot keep a message marked as working.

- Optional Linux host daemons (off by default) start Codex, Claude and Grok sessions from the Web/Chat or agent MCP. Per-host service account defaults to root, with eight work slots, 60-minute idle closure and 24-hour question expiry. Hosts show a dedicated green/yellow/red daemon indicator, readiness reasons and slot usage; durable operation receipts prevent replaying ambiguous starts. Wrapper 0.9.42 supplies `cxx daemon`.

- Agent Messaging send/reply receipts report current recipient presence and distinguish server storage from acceptance or reading. A receive-ready return sends one bundled server notice to each still-online sender with waiting mail; notices belong to that sender’s current session, never wake a later session, and require no reply. Wrapper 0.9.41 handles notices across Codex, Claude and Grok.

- Hosts replaces the Status column with per-engine readiness dots: green for current CLI/wrapper versions and present auth on secure hosts, yellow for missing auth or outdated/unknown versions, and gray for unassigned or suspended engines. Insecure hosts check versions only; host pins and fleet locks are respected, with reasons and installed/target versions in tooltips.

- Git Director opens on compact Settings, with a single selectable engine preview. Activity, merge requests and history have separate searchable tabs, linkable URLs and detail panels; operator actions stay in the relevant details.

- Policies now uses focused Host behavior, Agent behavior, Access control and Cleanup categories with a desktop sidebar and mobile selector. Immediate controls show save/read failures and respect capabilities; numeric forms validate whole-number ranges, preserve drafts across category changes and detect external edits. Insecure-host approval copy now describes access windows rather than browser windows.

- Wake / Cron shows agent launch names and a searchable name/alias/host picker. Creation, editing and execution details use a compact side panel, full-screen on mobile, with recovery fields shown only when enabled.

- Git Director now offers fleet-wide short/long commit messages and optional engine-specific `AI-Assisted-By` trailers. Defaults are short and attribution off. Managed Codex, Claude and Grok instructions carry the preferences independently of Director/Skills activation; the UI includes engine previews, audited capability-gated saves and cross-tab updates. Hosts adopt changes on their next content sync or launch.

- Active Clients shows agent launch names, working directories, explicit status, local Codex/Claude/Grok SVG logos and the latest compact summary. Name and summary search works across all engines; summary previews require transcript access.

- Wrapper 0.9.39 makes peer discovery searchable by name/alias/address and pageable with `limit`, `offset` and `next_offset`; the caller remains excluded. Conference invitations now reserve a seat as `invited` until explicit join (migration 0047 preserves historic join timestamps), and task grace deadlines stop at the room deadline. Managed Grok MCP starts keep automatic reception through their private leader even when a project definition omits `--auto`. Messaging tools explicitly describe UUID idempotency keys, omit session paths from errors, and recommend unchanged-payload retries only for uncertain transport/server failures or HTTP 408/429, rather than permanent rejections.

- Wrapper 0.9.40 makes `cxx update` a single host update run: equal wrapper versions skip download/restart, native Codex/Claude/Grok updates and content sync each leave a compact result, and capable terminals show animated checks and measured download bars. Engine suspensions, update policy, binary overrides and active-session locks remain enforced; partial failures remain nonzero. `--minimal` and redirected output use plain completion lines.

# 2026-10-08

- Wrapper 0.9.37 refuses messaging-enabled native starts until the server confirms a German launch name and matching identity. Codex, Claude and Grok receive their identity in per-launch model instructions; `agent_self` reads the authoritative current binding. Resume refreshes Claude system prompts and native receiver naming replaces historical launch prefixes while preserving task titles. Strict registration rolls back on name-pool exhaustion; same-launch recovery cannot silently change its name.

- Wrapper 0.9.36 adds a bounded Watchdog for Codex, Claude and Grok: session-scoped AI tools and a managed `#watchdog` Skill, operator CLI/Admin controls and read-only Portal status. Authenticated server keep-alives carry progress, wake, deadline and recovery metadata independently of model availability. Capacity/crash/hang recovery resumes the same native transcript with backoff; active tools and user questions are protected. STOP, disable, task outcome and deadline stop future recovery; accepted work continues.

- Wrapper 0.9.35 places a centrally served MCP-memory reminder at native Codex, Claude and Grok memory entrypoints during startup, sync and content cron. Existing notes and file modes are preserved; repeated sync updates one owned block. Claude custom locations are tracked for cleanup, Grok v2 gets a durable topic visible in isolated runtimes, and disabling central MCP or explicit trust loss removes only managed reminders. Native memory switches stay unchanged.

- Android companion 0.4.8 displays the assigned German launch name with the task title in chat rows, headers and search, including unnamed launches and already-prefixed server titles. Restricted companion snapshots also redact the separate task-title field.

- Wrapper 0.9.34 assigns random fleet-wide German female names per managed launch from a pre-filled 664-name server pool, reserves them until exit plus 24 hours, and displays `(Name) Task title`. Added name/UUID translation via CLI, MCP and authenticated API, direct named message/conference recipients, immutable delivery UUIDs and historical name snapshots. Managed guidance and WebUI now show the naming contract.

- Wrapper 0.9.33 and managed fleet guidance treat authenticated agent messages as collaboration and delegated work within existing operator authorization across Codex, Claude and Grok. Messages cannot override higher-priority instructions or expand permissions; claims and artifacts still need evidence. Conference, MCP and native/relay guidance now agree, while informational replies, publications and Wake/Cron authorization retain their existing contracts.

- Android companion 0.4.7 explicitly handles Android's JSON null values when choosing session names and IDs, keeping unnamed sessions identifiable instead of displaying the literal text "null". Verified with Android runtime regression coverage and the deployed phone.

- Wrapper 0.9.31 sends private Grok leader stderr to per-run, owner-only diagnostic logs (at most 1 MiB per file), preventing background trace lines from corrupting the native terminal. Native tool errors remain visible in the TUI and transcript. Startup failures name the log file; `cgx doctor` shows its directory. Existing sessions retain their running wrapper until resumed through the updated wrapper.

- Android companion 0.4.6 makes the native session name the primary chat identity, with host and working directory underneath and the short summary on its own line. Wrapper 0.9.32 forwards bound Codex, Claude and Grok naming metadata through encrypted, idempotent session_named events; the companion exposes names only with transcript permission. Fleet startup guidance asks the AI to name unknown sessions through agent_session_name, whose atomic set-if-missing mode preserves existing names. Unnamed sessions show a short session ID, and search matches names, host and directory. Roll out the API and wrapper before installing the APK for native names.

- Agent Messaging: fresh conversations no longer inherit dormant mailboxes by working directory; exact native resumes (including pickers) retain their address, native conversation changes isolate old mail, and orphaned informational messages cannot launch replacement agents.

- Wrapper 0.9.29 makes one-shot CLI listen informational-only, preserves committed request receipts when waiting fails, and supports stable retry UUIDs for send/request/reply/call-join. The messaging API fences informational reply claims, stores replies and completion atomically, rejects changed relay reply retries, preserves receipts after recipient disablement, and commits expiry cleanup before returning renewal errors. Receiver registration retries enforce the original native identity and return the stored source membership. The fourth lifecycle audit adds MySQL and CLI regressions and accepts both native Grok receipt-tool display names in the isolated canary.

- Wrapper 0.9.27 limits conference join/say completion to matching informational deliveries, preserves held tasks, and requires a peer source before promising automatic reception. The API rejects work replies without accepted claims, Portal acceptance after lease expiry, and acceptance receipt retries from superseded claims or changed payloads; rejoining a conference preserves dispatched state. Fleet conference guidance describes these completion boundaries. The third lifecycle audit adds regression coverage and fixes a native Grok canary identity-read race.

- Wrapper 0.9.26 preserves outstanding peer and Portal work across receiver reconnects, retains original result/reply payloads after lost receipts, serializes concurrent completion tools, and releases revoked delivery claims. Portal acceptance commits active-turn tracking atomically and no longer depends on a second heartbeat. The messaging API preserves completion timestamps on retries and gives explicitly approved ordinary fresh starts a new 24-hour queue window and attempt budget. The second lifecycle audit adds failure-injection coverage and corrects result-release guidance.

- Wrapper 0.9.25 and the messaging API fix call/send retry recovery, request wait receipts, expired-before-acceptance work, post-execution result lease renewal, Grok SessionStart decoding, and Claude readiness before its first silent ping. Peer shutdown preserves Portal reception; mailbox rings include Server publications and prioritize current messages. Wrong-source reply errors name the correct peer or Portal tool; updated agent guidance and operator documentation distinguish automatic reception, explicit work results, and cancellation limits.

- Remove engine-scoped access from the working secrets store: Codex, Claude and Grok share all credentials. Remove the API/MCP scope parameter and dashboard selector; migration 0044 drops the obsolete scope column while preserving encrypted values, host ownership, provenance and read auditing. The Secret dialog also closes correctly after a successful save.

- Add a Grok MCP compatibility audit covering all 78 host tools, six optional operator tools and 26 local messaging tools, plus a disposable native-client catalogue probe.

- Wrapper 0.9.24 adds managed native `codex`, `claude` and `grok` starts with their native argument grammar, the existing fleet account/auth protections, and shared session-bound messaging through App Server, MCP Channels and ACP. Installation prepares per-user PATH shims without replacing provider binaries; native-entry diagnostics and removal support shell activation and rollback.

- Git Director now resolves one canonical registration per host/path, rejects relative clone directories and ambiguous legacy mappings, and supersedes old mappings only when no live merge lease is held.

- Wrapper 0.9.23 retries account launch reservations after transient 502/503/504 responses up to four times over 15 seconds, retaining the same idempotent lease ID and active account pin.

- Result-only peer completions notify the caller once with their summary in the same transaction; scheduled wakes retain results without peer replies.
- Agent work execution now confirms durable acceptance before starting; explicit encrypted task outcomes are separate from delivery status, with one-use operator grants for missing ordinary transcripts.
- Wake recovery adds exponential backoff, jitter, repeated-failure warnings and optional limits that pause the entire schedule; fleet AGENTS guidance covers management and result reporting for all three engines.
- Wrapper 0.9.22 advertises execution contract v2; older running sessions continue, while new work waits for compatible receivers.

- Added fleet Wake / Cron management via MCP, shared Skill and admin UI, with durable one-shot, Cron and interval schedules. Persistent crash/hang/capacity recovery is explicit opt-in; wrapper 0.9.21 resumes native sessions without fresh fallback and checks live policy before Linux hang termination.

# 2026-10-07

- Android companion 0.4.5 shows a calm Connecting and Loading your chats state on startup instead of a premature reconnect warning or Retry button. Actual connection failures still show reconnect controls immediately; chat drafts, freshness checks and permission boundaries remain intact. This APK-only update needs no server rollout.
- Android companion 0.4.4 gives the home screen a WhatsApp-inspired layout: compact green header, flat chat rows with circular engine avatars, timestamps and unread number badges, local chat search, and All/Unread/Needs you filters. Host approvals remain visible while filtering, and Review next becomes a floating action. Light/dark mode and large text are supported; filtering never marks replies read or changes permissions.
- Android companion 0.4.3 replaces the separate unread section and repeated New labels with compact per-session reply numbers in one Sessions list. Exact assistant-only counts use device-local read cursors; ended/offline history no longer expands the overview. Snapshots update one silent launcher badge instead of creating per-session history alerts, while real incoming reply alerts and permission checks remain intact. Deploy the additive read-only POST snapshot API before installing this APK.
- Android companion 0.4.2 shows unread reply counts and conversation indicators on Now, plus a silent launcher badge on supported Android launchers. Reply-specific server cursors survive reconnects and app restarts; opening a conversation only clears unread after its latest actual reply is visible at the bottom. Unread retained sessions remain available as read-only history, and progress, summaries, questions and attention do not create reply unread state. Notification permissions and device opt-out remain respected; deploy the additive API fields before installing this APK.
- Agent Messaging adds persistent opt-in groups and explicit single-agent/Server feeds, with scoped publication receipts, atomic encrypted fan-out, stable retry IDs, subscription bounds and publication rate limits. The admin Groups workspace exposes audiences and targeted Server publishing. Migration 0041 and wrapper 0.9.20 add seven matching MCP tools and managed guidance for all three engines; native receiver health and queue receipts are checked strictly, and informational relay deliveries can finish without an outgoing acknowledgement. This intentionally changes the served feature digest; update the API before wrappers and restart existing native sessions for the new receiver behavior.
- Wrapper 0.9.19 removes the automatic receiver's instruction to answer every peer delivery, which made closing acknowledgements bounce indefinitely. Codex, Claude and Grok guidance now treats received replies as informational by default and directs completion through `agent_listen` without sending another message; active questions, tasks and substantive call turns still use `agent_reply`. MCP guidance and managed fleet instructions carry the same stopping rule, intentionally changing the managed feature digest. Existing running receiver processes need the updated wrapper and a session restart to use it.
- Dashboard and Accounts now show Grok subscription usage, its actual weekly/monthly reset, shared-pool scope and reading age. The API polls the official Grok Build billing endpoint every five minutes per enabled account through the existing auth owner; failed polls retain a clearly stale last reading, and unknown data never becomes 0%. Migration 0040 persists the latest observation and poll status; CLI quota enforcement and account assignment are unchanged.
- Quick Settings adds immediately saved 256k/500k Grok context-window buttons (256k default), retained across model/effort changes and rendered into native Grok configuration. Wrapper 0.9.18 tracks dotted model IDs correctly, preserving local model settings when the fleet default changes.
- Android companion 0.4.1 replaces project initials with local Codex, Claude and Grok pictograms and the host/engine text line with a compact host badge, consistently in the conversation list and chat header. Full identities remain available to TalkBack.
- Android companion 0.4.0 introduces a coordinated light/dark design, compact conversation list, and iMessage-inspired grouped bubbles with timestamps and a rounded composer. New replies preserve your reading position and offer a jump to the latest message; pairing and host reviews use the same accessible, rounded styling.
- Android companion 0.3.0 uses one foreground WebSocket for live overview, approval and chat updates, with automatic reconnect and cursor-based catch-up. Agent-authored summaries appear on cards and in their corresponding push notifications; full replies stay in chat. Deploy the updated API before installing this APK; the older SSE endpoint remains available.
- Wrapper 0.9.17 adds optional short summaries to `agent_receiver_reply` and `cxx portal say/ask` for Codex, Claude and Grok. Managed receiver instructions request one sentence of at most 160 characters describing the latest result or decision needed. Existing callers remain compatible.

# 2026-10-05

- Fix the Appearance menu failing to open because its heading lacked a menu group. Header theme choices now save through the existing theme endpoint, survive reload, and stay synchronized with Appearance settings; failed saves restore the previous choice, and late startup reads cannot undo a user selection.

- Make API Access key-first: compact copyable endpoints and status above the key tabs, with routing, collapsible backend defaults, and the global API control in Configuration. Existing setting anchors and new-key deep links remain supported.

- Show all subscription accounts together without engine tabs when the fleet has six or fewer accounts; larger fleets keep engine filters. Account cards identify their provider, and Add account offers engine selection in the combined view.

- Replace engine pills in the hosts table with small status dots in Codex, Claude, Grok order: green when assigned and fleet-enabled, red otherwise, with engine/state tooltips and accessible labels.

- Show engine coverage as independent per-engine host counts and percentage bars, with missing version reports listed separately; multi-engine hosts count towards each engine instead of creating combination categories.

- Keep messaging and portal engine checks on their existing transaction connection to prevent database pool starvation during registration, address eligibility checks, and address re-enabling. Failed admin-status requests now preserve the current page instead of redirecting to the first-run wizard; existing fleets with an admin and at least one host skip automatic setup even without wizard history, and a bare setup URL returns them to the dashboard. Explicit step links still open the wizard.

- Simplify admin navigation: daily tasks share the open Workspace section; configuration and specialist tools start collapsed. Activity becomes Logs under Diagnostics, and Active Clients replaces it in the mobile bar. Saved section choices and direct log links remain available.

# 2026-10-04

- Android companion 0.2.1 tightens list, conversation, and approval spacing and uses square cards, buttons, sheets, and dialogs, retaining at least 48 dp action targets and system font scaling.
- Android companion 0.2.0 replaces the desktop-like tabs with a compact Now screen: only reachable agents, live decisions first, bottom-sheet host approvals with duration presets, direct question choices, and conversations without lifecycle noise. Offline or stale views disable actions and preserve message drafts; connection controls move under More.
- Android companion 0.1.2 trusts operator-installed Android user CAs for `codex-auth.uggs.io` only, fixing pairing to the fleet's private-CA endpoint while retaining certificate and hostname verification.
- Android companion 0.1.1 adds a paste fallback for the same one-time QR pairing payload, with server confirmation before connecting.
- Android companion: native text chat, question answers, host-access approval review, one-time QR pairing and device revocation from Account, plus optional durable FCM notifications. Desktop and phone approval decisions now serialize under a database transaction.

# 2026-10-03

- **Engine master switches (wrapper 0.9.16).** Codex, Claude and Grok each get a fleet-wide on/off switch at the top of **Engines**. Off suspends the engine everywhere: hosts refuse to launch it and stop its maintenance ticks, managed sync and messaging receiver; the server hands out no new leases, stops refreshing, verifying and quota-polling its accounts, refuses seeding, installers, AI assist (Codex) and adding it to a host; and every exposed API whose backend is that engine answers `503` (an API named after it but routed elsewhere keeps serving, and nothing can be routed onto it). Nothing is deleted — host assignments, accounts, canonical auth, keys and installed CLIs stay — so switching it back on resumes hosts on their next launch or within 15 minutes, without a reinstall; after a long pause an account may need re-seeding. Running sessions are not killed. Host routes answer `403 engine_disabled` with `scope:"fleet"`, admin actions `409`; `GET/POST /admin/engines/*` back the switches (audited as `admin.engine.state`). **Rollout:** deploy wrapper 0.9.16 and let the fleet update before switching an engine off. Older wrappers already refuse to launch a suspended engine and keep its signed config, but with a less specific message; they keep attempting its maintenance tick (refused harmlessly by the server), and an older `clx` also strips its managed Claude settings on the refused launch, which the next sync after re-enabling restores.
- **Any exposed API can be served by any engine.** `/v1`, `/anthropic/v1` and `/grok/v1` each get a backend — Codex, Claude or Grok — chosen in the new **Exposed APIs** table on API Access (one row per API: base URL, backend, on/off switch, active keys). Changes apply to the next request without a restart. Keys, URLs, wire format and error shape stay with the API, so rerouting never invalidates a key; the backend's subscription, model list and limits apply (Grok refuses streaming and images everywhere; on the Anthropic API Codex gets `system` inline, Grok never gets `max_tokens`, Codex reports zero usage). Model ids native to an API that the backend doesn't serve run on the backend's default model, named in the response. Existing installs keep every API on its own engine (migration `0038`). The per-engine disable switches moved into the table; `GET/POST /admin/api/surfaces` back it, and the old `/admin/{openai,claude,grok}/state` routes keep working.
- `/grok/v1` now gets the same open CORS treatment as `/v1` and `/anthropic/v1`.

- **Grok reaches Codex/Claude parity (wrapper 0.9.15, which also ships the unpublished 0.9.14 lease fix below).** Fleet Skills install natively under `~/.grok/skills` from a new `grok_skills` bootstrap bundle, with clx's verified, ownership-tracked semantics; the served Grok instructions point there. The security posture now sets Grok's `[ui].permission_mode` (Standard → `auto`). `cgx` gains `cron install|remove`, a paused (not refused) launch while another lifecycle syncs, the insecure-host approval box, the FQDN clone guard, `alias grok='cgx'`, a first-launch CLI install, native `--help` without an account lease, red `status` exiting 1 with `api=ok` when the server answered, downgrade/loop-guarded self-update that no longer re-downloads an unchanged CLI, version reports sent even when content sync fails, best-effort peer and skill sync, immediate provisioning when the host's engine set changes, a real `cgx doctor` report (CLI vs target, config, instructions, skill drift, auth, latency, disk, cron), and a multi-user-safe uninstall that keeps local cleanup going when the server delete fails.
- **Grok seeding uses a dedicated login.** The admin seed command now runs `grok login --device-auth` in a throwaway home instead of copying `~/.grok/auth.json`. xAI rotates the refresh token on every refresh, so a live native login shared with the orchestrator loses the race and the account drops to `grok_login_required`; `GROK_SEED_AUTH_PATH` remains for a login nothing else uses.
- **Grok 4.7.** `grok-4.7` (new default) and `grok-4.7-build-fast` join the catalog, model pickers and `/grok/v1`; existing fleet defaults keep their stored model. The admin Grok gateway section gains per-model switches, and the default picker offers only enabled models.
- Grok-aware copy across the admin console, manual, installer card (green `cgx`), MCP descriptions, validation messages and docs; the fleet precedence paragraph names `~/.grok/AGENTS.md`. This changes the served instruction digest once for every host.

- **Account leases survive sleep (wrapper 0.9.14).** A host that suspended longer than the five-minute lease TTL resumed with a reaped account session, and every later mid-session auth sync, statusline usage report, and Grok heartbeat failed with `Account session not found` until the CLI was restarted. cdx, clx, and cgx now re-reserve the same session ID on the bound account when a heartbeat returns 404, so the running child keeps its binding and fresh tokens reach the orchestrator again within about 30 seconds of resume. Processes started on 0.9.13 or earlier stay stuck until restarted.

# 2026-10-01

- **cgx wrapper updates (wrapper 0.9.13).** Grok's maintenance path passes its configured logger to the shared binary updater, fixing a panic when the server offers a newer wrapper. Existing 0.9.9–0.9.12 installations can recover through `cxx update` when Codex or Claude is installed, or through a new installer for the existing host; published binaries remain immutable.

- **cgx startup summary and MCP isolation (wrapper 0.9.12).** Grok shows the usual model/effort, version targets, measured sync health, and fleet activity before its native UI; visible interactive launches stay inline so the summary remains in scrollback. Status/doctor share the metadata, compact and silent modes retain their roles, and the footer reflects final cleanup. Unsupported quota and unprobed MCP health remain unknown. Private runtimes disable implicit Claude/Cursor MCP imports, preserving explicit Grok/project servers and the operator's original configuration; native all-server MCP doctor still inspects vendor imports, so named managed-server checks describe actual runtime servers.

- **Grok Build is the third engine (`cgx`, wrapper 0.9.9).** Hosts can run any nonempty subset of Codex, Claude, and Grok, with separate accounts, signed configs, CLI versions, models/effort, telemetry, and admin controls. Grok subscription OAuth refresh is centrally owned and durably fenced; access-only projections, isolated managed homes, a private leader, and generation-aware external auth preserve account identity. The native ACP receiver supports cross-engine messaging. The independent `/grok/v1` gateway uses scoped client keys, reports native usage/stop reasons when present, and explicitly rejects unsupported CLI controls. Official native packages are pinned and integrity verified; unavailable Grok quota remains unknown. Shared fleet guidance now names all three engines, deliberately updating its synced document digests.
- Grok host provisioning initializes missing fleet defaults so managed MCP features activate; concurrent provisioning and operator saves preserve authored policy.
- Startup publishes the verified shared wrapper version and per-engine runner health for Grok alongside Codex and Claude, so new Grok hosts receive the served binary and an independent runner verdict.
- **cgx bootstrap sync (wrapper 0.9.10).** Consume the already-decoded instruction and config resources from the shared bootstrap client directly; real Grok content no longer fails with `invalid managed Grok resource`.
- Grok maintenance reports update its own measured CLI and wrapper versions, preserve unreported values, and leave Codex and Claude telemetry intact. Auth responses expose Grok's parallel host metadata, with unknown values reported as null.
- **cgx background maintenance (wrapper 0.9.11).** Normal launches, sync, status, and doctor request the shared coordinator with Grok's config path, restoring automatic updates, schedule repair, and version reporting on Grok-only hosts without queuing another maintenance loop.

- **Call receiver readiness and silence notices (wrapper 0.9.8).** Call opening reports derived presence; joining an opener that is not listening returns `agent_messaging_call_peer_not_listening` and preserves the PIN. Automatic `agent_listen` reports receiver health and the current claim gate. Unanswered outbound `CALL/1` messages trigger a local status notice after 90 seconds, with one reminder at most; replies and cancellation stop the watch. Managed call/conference guidance now distinguishes automatic reception from timed listening. Reminders use separate native queue IDs, and a disconnected Codex queue cannot fall through to Claude channel transport.

# 2026-09-30

- Fixed empty host-approval popups: only live, unexpired, unresolved pending requests trigger an automatic dialog; resolved or non-waiting rows cannot reopen it, and automatic dialogs close when the queue drains.

- Host approval requests now open the modal on connected admin clients as soon as they arrive, including before the host polls again and when the pending count stays unchanged. The modal closes after all requests are approved or declined, including in management mode, once result feedback finishes.

- Account consolidation retains compatibility aliases for already-running wrappers, preserving auth uploads, session reservations and quota reports after duplicate rows are merged.

- Fixed account/session conflation: fresh opaque OAuth tokens reuse the sole account or their explicit session/host assignment instead of enrolling phantom accounts. Additional opaque accounts require Add account or an untargeted seed command; migrated provider identities are recovered from their existing head. Multiple unassigned opaque accounts return `account_assignment_required`, and known cross-account replacements remain rejected.

- Added independent ChatGPT and Claude account pools with automatic enrollment, account-scoped credential verification/refresh and quotas, and launch-time balancing across verified accounts. Concurrent native sessions keep the same account and existing quota/VIP policy remains in force.
- Added Fleet → Accounts for enrollment, naming, credential replacement, verification, pause/resume, quota/assignment inspection and removal after sessions drain; dashboard usage is shown per account. cxx 0.9.7 scopes both cdx and clx auth synchronization to their selected account.

# 2026-09-29

- **GPT-6.1 Sol supported.** Added `gpt-6.1-sol` to Codex model selection and OpenAI-compatible inference, with native `low` default effort and all six effort levels through `ultra`.

- **Codex profiles are delivered as `<name>.config.toml` files (wrapper 0.9.6).** codex-cli 0.156.1+ fails `--profile <name>` ("failed to load configuration") when `config.toml` carries `[profiles.*]`, so `cdx <profile>` was broken on current hosts. For a host reporting Codex 0.156.1+ (or none) the server now leaves `[profiles.*]` out of `config.toml` and returns a `profiles` list on `/config/retrieve` and `/sync/bootstrap`; the wrapper writes `$CODEX_HOME/<name>.config.toml`, tracks what it wrote in `.cxx-managed-profiles.json`, and prunes only those files (a user-authored profile file is never removed or overwritten). Older Codex builds keep the tables. The layout was verified live on 0.156.1, 0.157.0 and 0.158.0, and a rendered profile passes `codex --strict-config`.
- **Fixed: Contained / Restricted posture levels rendered `approval_policy = "untrusted"`, which codex-cli 0.158.0 rejects.** Codex refuses to load the whole config ("no longer supported; remove this setting"), so `cdx` and `codex mcp list` failed on those hosts. Levels 0–2 now render `on-request` (still under the read-only sandbox at 0–1), and a stored `untrusted` heals to `on-request`.
- **Codex feature flags `guardian_ext`, `personality` and `remote_compaction_v2` are dropped** (stage `removed` on 0.158.0). The top-level `personality` key is unchanged.
- **Claude `statusLine` keeps only its typed keys.** A non-numeric `padding` (no `.catch` in the 2.1.284 schema) would invalidate the status line and with it the quota telemetry; `padding` / `refreshInterval` are now passed only when valid. The hooks editor also offers `PostToolUseFailure`, `SubagentStart`, `PermissionRequest`, `PermissionDenied`, `TaskCompleted`, `ConfigChange` and `Setup`.
- **Claude Sonnet 5.5 (`claude-sonnet-5-5`) is supported.** It is in the inference gate, the `/anthropic/v1/models` catalog, the model pickers, and the effort tables (persistent `low`–`xhigh`, default `medium`, per the claude-cli 2.1.284 catalog). The advisor-pair tables now know Opus 5.5 and Sonnet 5.5, and the `opus` / `sonnet` advisor aliases resolve to them, as the CLI's own alias table does. The default model stays `claude-sonnet-5`.
- **Codex catalog re-verified against codex-cli 0.158.0; the `spark` lane is retired (wrapper 0.9.6).** `gpt-5.3-codex-spark` is gone from the catalog and binary, a live `codex exec -m` is rejected ("not supported when using Codex with a ChatGPT account"), and the usage endpoint no longer reports a Spark bucket. It leaves the supported-model list and heals to `gpt-6-astra` like the other retired ids. `cdx lane spark` and `cdx ls` print one line and exit 2 without a request; `/host/lane` still accepts `spark` from older wrappers and stores `null` (inherit — `normal` would pin Astra over a per-host override), and migration 0034 clears stored `spark` preferences. `cdx lane normal|clear` is unchanged, and the Spark usage columns and dashboard windows stay (they simply have no data).

# 2026-09-28

- **Quick Settings for Codex and Claude.** A new Fleet page offers model buttons and model-specific effort segments with immediate saving. Switching models selects their catalog default effort; failures restore the confirmed selection and refresh before another change. Available in desktop navigation, the mobile menu, and the command palette.
- **Fixed: skill/project AI drafting (`/admin/skills/{generate,assist}`, `/admin/projects/:slug/assist`) timed out after 8s.** `generateSkillDraft`/`assistSkillDraft`/`assistProjectDraft` inherited `AUTH_RUNNER_TIMEOUT` (the fast credential-probe budget) instead of `AUTH_RUNNER_EXEC_TIMEOUT` (the full-CLI-turn budget the OpenAI/Claude compat adapters already use), so any draft call that legitimately took the runner more than ~8s to complete a non-streaming LLM turn came back as `runner_failed`. All three now default to `AUTH_RUNNER_EXEC_TIMEOUT` (600s).
- **Live conference inspector in Agent Messaging.** A Conferences tab shows open, adjourning, and past rooms, all members, task deadlines, delivery failures, and the combined message timeline. Operators with content access can explicitly reveal an audited transcript and follow new replies. Inspection is read-only, supports both engines, and works with existing conferences.

- **Claude (and Codex) native receivers no longer stall in conferences (wrapper 0.9.5).** The automatic receiver holds one peer delivery until the model is done with it, and the server leases one per address, but only `agent_reply` ever released it. A conference invite (answered by joining), a chair's message (answered in the room) or a turn-terminal `WELCOME`/`NOTED` therefore wedged reception until the message's 24h TTL: later messages sat queued, the Stop hook kept ringing, and `agent_listen` only returned the "automatic" stub. `agent_conf_join`, `agent_conf_say` and `agent_listen` now release the held delivery (listen still never claims), and the managed AGENTS/CLAUDE block tells the model to call `agent_listen` once after a message it finishes without a reply (a deliberate text change, so the managed block re-serves fleet-wide). Already-running sessions need a new `clx`/`cdx` launch; a wedge from the old binary clears when that session exits.

# 2026-09-23

- **clx installs on hosts without a usable Node.js, e.g. XCP-ng (wrapper 0.9.4).** XCP-ng 8.3 dom0 (CentOS 7 base, glibc 2.17) has no `nodejs` package and nothing supplies Node >= 22, so host setup died at *Node.js install failed*. The installer's Node.js/npm step now warns and continues, and without npm the managed install downloads the pinned native Claude CLI from `@anthropic-ai/claude-code-<os>-<arch>[-musl]`, verifies the registry sha512 integrity, and publishes it under `~/.cxx/engines/claude` like the npm path; a failing npm install falls back the same way, and `clx doctor` no longer requires Node.js.
- **Setup wizard streamlined end to end.** After `bin/install.sh` creates the owner, the console sends a signed-in admin with an unfinished wizard and open checklist items to `/admin/setup` once per browser session, starting at Engines. Skip on Fleet defaults saves catalog defaults (no more silent `config_missing`); Skip on Engines records nothing; progress marks follow step ids; Continue/Finish submit typed credentials and hostnames; a 401 goes to `/login?next=/setup`. Dashboard setup items are links. One stepper, choice cards, footer-only actions, success/warning tokens, read-only code blocks, and a Claude effort picker across all steps.
- **One host registration form with live install progress.** The Hosts sheet and the wizard share `HostRegisterForm`; engines default to the wizard answer. Chips now say what they do: *Trusted — no approval window* and *Skip TLS verification* are independent (the "mTLS only" label was wrong). After minting, a timeline shows Installer fetched → Wrapper installed → First sync (polls every 5s), with inline *Seed credentials* and *Re-mint installer* (never re-registers, so the API key is not rotated). Quick VM copy: the token lasts 30 min, the temporary host 2 h.
- **cdx/clx first run (wrapper 0.9.3).** A progress line while syncing, uploading and installing; a missing engine CLI is installed in the foreground before giving up with exit 127; `cdx` now offers `codex login` when no credentials exist anywhere, and both engines ask (default yes) before a native login and never start one without a TTY. Repair hints read `cdx cron run` / `clx cron run` everywhere. Skills listing and the version probe overlap the sync call.
- **Installer token errors now reach the terminal.** `/install/{token}` and `GET /seed/auth/{token}` answer used/expired/missing tokens with HTTP 200, `X-Installer-Error: <code>` and a script that prints the reason to stderr and exits 1; the old 4xx made `curl -fsSL … | sh` run an empty script. Consuming an installer publishes `host.updated`, and `/admin/hosts` + host detail gain `installer_used_at` / `installer_expires_at`.
- **Host installer preflight, first sync, and aligned notices.** Missing `python3`/`curl` or an unwritable bin root stops before the header card with one line and a fix each; after the CLI checks each engine runs one non-fatal `--allow-concurrent-sync sync` (warn, never `INCOMPLETE`); the duplicate `cxx agent service install` is gone (`cron run` installs it). Notice lines follow the wrapper grammar: 7-wide topic, detail on the next line, ASCII `+ ! x >`, piped form `cdx topic: message`. Retry hints read `cdx cron install` / `cdx cron run`.
- **Setup status: live database probe, wizard engines, fleet defaults.** The `database` check runs `SELECT 1` and reports failure instead of 500ing; `default_engines` (wizard answer, else configured) drives the auth next actions; new `fleet_defaults` next action before `first_host`.
- **`bin/install.sh`: data root follows the domain; no runner-URL prompt; `--tls` required when scripted.** `urls` runs before `dataroot`, whose default is `/var/docker_data/<domain>`. `--non-interactive` lists a missing `--tls` with the other missing values instead of silently choosing `none`. `verify`/`doctor`/owner read the 503 `/readyz` body and print each failing check with its fix. The owner step validates username/email like the server and prints the API's error message; the closing message points at `/admin/setup`.
- **README rewritten with fresh screenshots.** Feature-first tour with twelve new images of the current console, portal and `cdx`/`clx` boot screens; regenerate them with `cd frontend && npm run shots:readme` (Playwright against a mocked demo fleet).
- **Hotfix: IPv6-bound hosts rejected with `ip_mismatch` since wrapper 0.8.14.** 47 hosts were bound IPv6-only and now dial over IPv4; migration `0033` releases those bindings so each host rebinds on its next request (same as *Release IP binding*).
- **Engine enable/disable applies on the next `cdx`/`clx` launch (wrapper 0.9.2).** A changed `/auth` engine set queues maintenance past its cooldown instead of waiting up to 15 minutes.
- **Host installer adopts the `cxx` terminal UI.** `/install/{token}` shows a host card, wrapper notice lines and engine badges on UTF-8 terminals; piped/`LC_ALL=C`/`TERM=dumb` output unchanged.
- **Insecure approvals alert moved to the sidebar.** Amber nav item with count linking to `/hosts?insecure=1` on every page; the Overview banner is gone.
- **`scripts/deploy.sh` publishes the `cxx` wrappers.** Bump `VERSION` in `wrappers/Makefile` and deploy; builds four platforms, verifies the signing key, publishes, recreates the api. `--skip-wrappers` opts out.
- **Quota provider question: usage bars and `1`–`4` hotkeys (wrapper 0.9.1).** Keys follow the provider (`1` cdx, `2` clx, `3`/`4` remember for today); Enter keeps the invoked engine.
- **cdx/clx terminal UI refresh (wrapper 0.9.0).** One `✓/▲/✗ <persona> <topic>` message grammar, arrow-key menus for questions, 24-bit palette; pipes/`--minimal` keep line prompts. Requires Go 1.25.8.
- **Agent chat redesigned Messages-style** on `/go` and Active Clients: searchable conversation list, bubble thread, pill composer, *Needs you* bar with quick replies.
- **Codex models `gpt-6-sol` and `gpt-6-luna` added** (default `medium`; codex-cli 0.156.1). `gpt-5.5` stays until its 2026-10-14 retirement.
- **Insecure-access approval dialog redesigned.** Stale requests retired server-side every 10s (new `expired` status), caller IP recorded, focused per-host cards with countdown and Approve/Allow domain/Deny.
- **Fixed `config.toml` drift against codex-cli 0.156.1.** Dropped removed keys, `local_provider` → `oss_provider`, no more top-level `profile` (now a hard boot error upstream), per-profile sandbox tables and `[security]`.
- **Added `claude-opus-5-5`** to the Claude model catalog (default effort `medium`).
- **`cdx update`/`clx update` now update the engine too** via `EnsureEngineCurrent` after every `sync`, not only on the cron tick.
- **Fixed `401 ip_mismatch` on dual-stack hosts (wrapper 0.8.14).** Wrapper HTTP clients now prefer IPv4 (`ipv4.PreferDialContext`), falling back to IPv6 only without an IPv4 route.

# 2026-09-22

- **Lean Projects reads.** New `project_summary` (call it first), `project_files`, `project_notes`, `project_feedback_list`, windowed `project_file_read`, `project_changes payloads:"preview"`, `project://{slug}/summary`.
- **`project_changes` accepts `since_seq`** as an alias and no longer truncates `since` to 32 bits.
- **Project files capped at 4 MiB** and accept `encoding: "base64"` (migration `0031`); digest/size describe decoded bytes. Mime type inferred from extension.
- **Project tool schemas closed** (`additionalProperties: false`); unknown args error, enums enforced case-insensitively, legacy aliases declared.
- **Board cards gain `due_at` and dependencies** (migration `0032`): `ready`/`waiting_on`, advisory `depends_unmet` on claim, cycles refused.
- **Board templates.** `project_create`/`POST /admin/projects` take `board_template`: `software` (default) or `migration`.
- **Projects can be finished.** New `project_update`, `project_archive`/`project_unarchive`, `project_feedback_update`, `project_note_delete`; `project_list include_archived`; console Archive/Reopen.
- **Console project tabs stop fetching every file body** via `GET /admin/projects/{slug}/summary` and `/files/{id}`.
- **Fixes:** `project_summary` board status always "disabled"; project memory events now refresh open Activity tabs.
- **Managed `coco` skill** now opens with `project_summary` and covers the lifecycle steps (hosts resync it).

# 2026-09-20

- **`cxx agent doctor --json` reports `channel_policy` for Claude** (`approved` / `fallback`), exposing hosts on the development-channels fallback.

# 2026-09-19

- **Fixed Claude messaging on pre-0.8.11 wrappers.** The plugin-shaped `cxx-agent` config and permissions are now gated on the host's reported wrapper version.
- **Old engine versions are swept.** Each maintenance tick keeps only the selected version under `~/.cxx/engines/{claude,codex}`; uninstall/disable removes the store.

# 2026-09-18

- **Claude stops prompting for development channels.** `clx` ships `cxx-agent` in its `cxx-receiver` plugin, approved via a `managed-settings.d` drop-in (falls back to the prompting flag).
- **Claude permission allowlist moves to `mcp__plugin_cxx-receiver_cxx-agent__*`** and adds `Bash(clx:*)`/`Bash(cxx:*)`; user-scope `mcpServers.cxx-agent` no longer served.

# 2026-09-17

- **Compatibility API requests get their own runner timeout.** `AUTH_RUNNER_EXEC_TIMEOUT` (default 600s) replaces the inherited 8s probe timeout.
- **cxx 0.8.10 removes receiver chat probes;** reception uses silent native health checks and the UI offers Reconnect receiver.

# 2026-09-16

- **cxx 0.8.9 auto-connects interactive sessions to peer/portal reception** via native queues/Channels; Clients and `/go` show receiver evidence.

# 2026-09-15

- **Claude login expiry warnings (wrapper 0.8.8).** Dashboard and clx show a three-day countdown with renewal instructions.

# 2026-09-14

- **Quota-based provider choice at startup.** cdx/clx recommend the less-pressured provider, optionally remembered until midnight (`run --quota-choice-reset`); configured under admin Quotas.

# 2026-09-13

- **Runner ships Codex 0.154.0** with checksums, fixing rejected `gpt-6-astra` probes that blocked credential acceptance.
- **cxx 0.8.6:** final credential uploads share one 15s budget. Request IDs now match between logs and response headers.

# 2026-09-11

- **`cxx remote` scaffold (default off, `remote_exec_enabled`).** SSH ControlMaster reuse with on-disk job state; remote operations currently return `not implemented`.

# 2026-09-10

- **Cron ticks no longer request credentials.** Content-only sync stops per-tick approval requests and Claude trust-loss teardown on insecure hosts.
- **`/sync/bootstrap` and `/sync/status` skip the insecure-window check** when `include_auth: false`.

# 2026-09-09

- **File transfer between agents** (off by default): `transfer_put/get/info/delete`, chunked by `offset`, required `ttl_seconds`, byte caps, per-file audit trail, `transfers.download` capability.
- **Insecure approvals:** resolved rows animate out; allowing a domain approves all its pending hosts; approvals default to 8 hours; domain allows can be permanent.
- **Documentation re-aligned with code** across README, `docs/*.md`, wrapper README and the manual.

# 2026-09-08

- **Needs you banner** above the composer in both WebUIs; `cxx portal resolve --summary` withdraws an attention notice (cxx 0.8.4).
- **Active Clients rebuilt (cxx 0.8.3)** with counts, filters, search and resilient refresh/stream reconnection; presence and delivery reject expired bridges and disabled hosts.
- **cxx 0.8.2: upgrades move to background maintenance.** Launches never wait on engine/wrapper updates; one coordinator, cron every 15 min, atomic engine installs.

# 2026-09-07

- **cxx 0.8.1 auth hardening.** Both engines upload rotations every 2s, pull canonical changes mid-session and preserve concurrent native writes.
- **cxx 0.8.0 terminal output overhaul** with a shared renderer, quota meters and a PTY verification matrix; Claude quota reports added to status output.
- **Fixed Codex quota reset countdowns** after a window expires, and engine routing so Claude requests never fall back to Codex state.
- **cxx 0.7.28:** `cdx sync`/`clx sync` exit nonzero on failed writes or offline fallback.
- **Admin shell refresh:** navigation, per-engine runner status on Overview, engine settings with unsaved-change indicators.

# 2026-09-06

- **Claude settings audit.** Fixed `outputStyle` (keyed by frontmatter name), fleet hooks shape, `advisorModel` (haiku dropped, rank pairing enforced), `statusLine` validation, clx argv parsing for five value flags; added `SessionEnd`/`PostCompact` hooks.
- **Engine audit against codex-cli 0.153.4 / claude-cli 2.1.261.** `gpt-5.4-mini` retired → `gpt-5.6-luna`, `gpt-6-astra` gains `ultra`, Sol default `low`, `claude-fable-5-1` added, 23 removed feature flags dropped, missing subcommands forwarded.
- **`cdx --execute` docs corrected:** it runs with the fleet's sandbox policy, not read-only; wrapper-only flags documented.

# 2026-09-05

- **`gpt-6-astra` is the Codex default** (`medium`); catalog trimmed to seven models, `gpt-5.4` selections migrate to Astra.

# 2026-09-04

- **Console can talk to agents.** Migration `0027` lets admin users author agent messages; `/go` accepts console sessions; composer, prompt answering and close actions in the console.
- **Active Clients page** (`/admin/clients`) with presence, current task/branch and force-close; `agent_portal.reveal_transcript` gates timelines.
- **Agent presence derived from heartbeats.** `agent_list(online:true)` stops returning dead agents; Git Director reclaims crashed holders within 45s; `agent_list` ranked and capped at 50.
- **ChatGPT usage card** shows only reported windows, adds the Spark lane and fixes sparkline/history labels after the July payload change.
- **Fleet insecure window.** One deadline (5 min–24 h, default 8 h) admits all insecure hosts; closing clears host windows and domain allows; TopBar countdown.

# 2026-08-27

- **Project board with claims replaces todos** (migration `0026`). `project_board_list`, `project_card_create|claim|move|release|update|get`; claims reclaimed on agent death or 30-min TTL; `project_todo_*` keep working as a card view.

# 2026-08-25

- **Legacy-launcher hosts get `cxx` on `PATH`,** fixing the `cxx-agent` MCP server failing to start.
- **Fixed wrapper publishing leaving 0700 directories** that the API couldn't read, stranding hosts on the previous version.

# 2026-08-24

- **Git Director** (off by default, `git_director_enabled`): `git_register|list|join|merge_request|merge_status|release`, advisory per-clone merge arbitration with model verdicts only on contention, dead-agent reclaim, console page (migration `0025`).

# 2026-08

- **Default-deny admin authorization.** Every `/admin/*` and session-guarded `/cli/auth/*` route now maps to one capability in a role matrix (`api/src/security/capabilities.ts`); the API refuses to boot on an unmapped route, and denials return `403 admin_role_required`. Migration `0022` sets `compatible` mode on existing installs (behavioral no-op, logs would-be denials at `GET /admin/authorization`) and `strict` on fresh ones; `POST /admin/authorization` switches. Closes a live leak: `GET /admin/hosts/{id}/auth?include_body=1` now needs `auth.reveal_credential` (owner/admin only).
- **Refresh-token races closed for both engines.** Runner `/verify` probes now use refresh-stripped credentials (empty `tokens.refresh_token` for Codex), `/exec` no longer returns `updated_auth`, expired-access canonicals keep their verdict instead of being probed, and `cdx`/`clx` upload mid-session rotations every 30 s. The per-user `cxx-agent` worker also watches Claude credentials so detached `claude daemon run` rotations are uploaded (wrapper `0.7.23`).
- **Adaptive verifier cadence.** Re-probe interval grows with proven-good age between the 900 s TTL and `AUTH_RUNNER_VERIFY_MAX_INTERVAL_SECONDS` (default 6 h); successful gateway execs count as verification.
- **`#call` and live agent conversations.** Agents dial each other with a single-use four-digit PIN (`agent_call_open`/`agent_call_join`/`agent_listen`, `cxx agent call-*`); `agent_messaging.listen_enabled` lets interactive sessions receive. All four Codex/Claude directions verified live; `agent_send` over MCP fixed; relay install enables `loginctl` lingering. Agent Messaging is now governed by the fleet switch alone (insecure hosts inside their window included; `POST /admin/hosts/{id}/agent-messaging` removed; needs cxx `0.7.8`), and the served `AGENTS.md`/`CLAUDE.md` gain an Agent Messaging section.
- **Fleet security posture: nine 0–4 axes.** Replaces the frozen policy literal with an operation matrix projected into Hard Stop Lines, safety floor and a new `## Standing Authorizations`; applied as a bake-time overlay on `config.toml`/`settings.json` via named profiles (`agent_policy_profiles`, migration `0018`). Fleet Instructions gains a Generated/Manual/Disabled switch (`/admin/agents-generation-mode`), a live effective-document preview, and setting↔block provenance highlighting.
- **Guided installer and first-run wizard.** `bin/install.sh` (twelve resumable steps, `--json`, `--non-interactive`, `doctor`) replaces `bin/setup-quick.sh`; `migrate.js --init-schema` bootstraps an empty DB from `api/src/db/baseline/schema.sql`. `/admin/setup` becomes a nine-step wizard (`setup_wizard_state`) with a shared `SeedAuthPanel`. Client-certificate mTLS generation removed (`ADMIN_ACCESS_MODE` is `cookie|open`); Caddy ACME state now persisted in volumes.
- **`cxx sync` and content convergence.** New `cxx|cdx|clx sync`; `cxx update` re-execs into a sync-only pass and the nightly `cxx cron run` tick now syncs managed content. Session-exit engine installs re-resolve their target via `POST /cron/check` (`probe: true`), and per-host client version pins finally reach wrappers.
- **Agent Portal honesty pass.** Relay opens only during a live `cxx portal wait`; new `working` presence; force-end reachable for dead agents; undelivered messages marked; freshness windows configurable (`AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS`, `AGENT_PORTAL_RELAY_FRESH_SECONDS`). Every long poll in the fleet had returned instantly (`req.raw.destroyed` misuse); fixed.
- **Wrapper config lifecycle.** Signed configs carry a 30-day `expires_at` (`WRAPPER_CONFIG_TTL_SECONDS`) with self-healing refetch; multiple active signing keys can co-sign (`signatures` array, `api/src/ops/rotate-signing-key.ts`); golden round-trip fixtures under `wrappers/testdata/`. `hosts.config_baked_at` dropped (migration `0017`).
- **Removals.** All orchestrator-enforced rate limiters (migration `0019`; use the reverse proxy); the non-actionable Codex CLI update banner; the fleet-policy prohibition on writing secret values when a task requires it.
- **Optional OpenTelemetry.** API bakery spans behind `OTEL_TRACES_ENABLED`; wrapper spans only in `-tags cxx_otel` builds, gated by `CXX_OTEL_TRACES_ENABLED`.
- **Admin console rebuild.** Route-registry navigation with canonical Engines/Policies/Agent Portal/Knowledge routes (308 redirects for retired URLs), neutral zinc/slate theme, Fleet Policy Builder with versioned AGENTS.md (v55), Secrets discovery guidance, `GET /admin/setup/status` and `/readyz`.
- **Fixes:** host engine toggles now converge via peer-reconcile (Go npm bootstrap, cron no longer aborts on cleanup failure); Codex `web_search` emitted as the string enum (a boolean broke every host's config); relay honors `Retry-After` on 429; heartbeat no longer fails for pre-switch sessions; migration `0016` made idempotent; clearer spent-`#call`-PIN error.

# 2026-07

- **Single `cxx` multicall wrapper.** `cdx`/`clx` become relative aliases to one binary built for four platforms; installers install it once, migrate legacy binaries, and run one host-wide `cxx-managed` cron (cxx `0.7.1`–`0.7.2`). Host detail reports one CXX wrapper version.
- **Agent Messaging and Agent Portal.** Default-off fleet bus for encrypted one-to-one agent messages with ordered at-least-once delivery (`cxx agent`, MCP tools, admin views). Permanent per-user Agent Portal at `/go` (cxx `0.7.5`), made pull-only on 2026-07-30: Matrix push removed (migration `0009`), `POST /admin/agent-portal/users/{id}/resend` gone, links revealed via `GET /admin/agent-portal/users/{id}/link`.
- **Fleet secrets store.** `secrets` table (migration `0010`), MCP `secret_list|search|get` with per-read audit, admin CRUD under `/admin/secrets` plus role-gated reveal, and a managed `## Secrets` block in served agent docs.
- **Memory stores.** Project-scoped `project_memory_*` (`coord_project_memories`), fleet-wide `shared_memory_*` documents with chunked FULLTEXT search and `shared://` resources (migration `0006`), a managed Memory routing block, and the Memory Atlas admin workspace with `/admin/memories` ETag lifecycle API.
- **Automatic migrations.** `api/src/db/migrator.ts` applies idempotent SQL on boot (`RUN_MIGRATIONS_ON_BOOT` default on) and from `scripts/deploy.sh`, tracked in `schema_migrations`; `npm run migrate[:check]` CLI.
- **Verified-only canonical auth.** Codex/Claude credentials must pass live runner verification before acceptance or distribution; unverifiable readbacks are quarantined; a generation ledger rejects replays and rollbacks (180-day history). Wrappers `0.6.46`–`0.6.53` harden concurrent sessions, logout intent, and local-first recovery.
- **Compatible API gateways conform to SDKs.** `/anthropic/v1/*` and `/v1/*` now match upstream error types, model endpoints (`GET /models/{id}`), token-cap params, `count_tokens`, and fail closed on unsupported tools/content; a `max_tokens` → CLI flag 502 was fixed.
- **Skills.** Managed `#context` and `skill-manager` skills; agents can `skill_store`/`skill_delete` over MCP; opt-in Matt Pocock skill source; Claude skills sync as complete directory bundles (cxx `0.7.3`).
- **Models and defaults.** GPT-5.6 Sol/Terra/Luna (Terra/medium default), Claude Sonnet 5 default plus Fable 5, Opus 4.8 and Opus 5; fleet model/effort defaults via `/admin/model-defaults/:engine`.
- **Terminal UX (`0.6.44`–`0.6.45`).** Responsive shared dashboard, `--minimal`, `--wrapper-help`, truthful quota/forecast display; `cdx resume`/`clx resume` now actually resume.
- **Admin UI.** Task-based navigation, light/dark system, password-reset flow, Release IP binding action, Switchyard brand mark, list+detail CRUD pattern.
- **Fixes:** `cdx --execute` no longer forces a read-only sandbox that disabled MCP (`0.6.55`); dual-engine cron staggered by 30 min; fresh `cdx login` no longer clobbered by stale canonicals (`0.6.41`); `/sync/bootstrap` envelope unwrapped; insecure approvals auto-deny after 5 min; `curl_insecure` covers installer downloads; ChatGPT quota refresh every 15 min; MySQL 8.4 native-password flag.

# 2026-06

- **Auth verification moved to a background worker.** `/auth` retrieve and `/sync/bootstrap` now return the stored `verification_state` instead of probing the runner inline; a worker re-verifies both engines every `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (default 300s).
- **Launch gate proves auth before reporting green.** `ensureServedVerification` runner-verifies served canonical auth for Claude and Codex (TTL `AUTH_RUNNER_VERIFY_TTL_SECONDS`, default 900s, single-flighted); wrappers refuse on `verification_state=failed` rather than launching into a 401 or dead refresh token.
- **Interactive login recovery.** `cdx` and `clx` offer `codex login` / `claude auth login` when managed credentials fail, upload the result through `/auth command=store` and re-check; non-interactive runs fail closed. `clx auth ...` passes through.
- **cdx and clx production-readiness passes.** Fixed `cdx lane`, the `-4` IPv4 proxy for HTTPS, `cdx doctor` verdicts, skills change detection, Spark quota decoding, `QUOTA_HARD_FAIL=0`, the FQDN guard ordering, `clx help` hangs, OAuth offline freshness, and unverified peer-bundle signatures.
- **Claude permission mode defaults to `auto`.** Rendered as `permissions.defaultMode` (the key Claude Code actually reads) and always emitted; pin `default` in Authoring → Fleet settings to get prompting back.
- **Claude auth is native account login.** `claudeAiOauth` is preserved canonically, `clx` stops injecting `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`, and fleet skills sync to `~/.claude/skills/<slug>/SKILL.md`.
- **Per-host engine switches and dual-engine cron.** Hosts toggle Codex/Claude individually (disabled routes return `engine_disabled`); one `--cron run` keeps both wrappers and both CLIs current, and installers bootstrap the primary engine too.
- **Removed token-usage counting and Joplin.** `POST /usage`, the token admin endpoints/tables and dashboard cards are gone (drop migration `0001_drop_token_usage.sql`); the Joplin integration and its tables were removed. `claude_artifacts` table added.
- **Ops and UI.** Added `scripts/deploy.sh`; Codex allowlist is `gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`/`gpt-5.3-codex-spark`; Claude advisor model is fleet-managed; Users moved to Settings → Users; runner state and host online status became engine-scoped and contact-based.
- **Fixes:** `clx` MCP servers now land in `~/.claude.json`; explicit `/auth` store failures surface as errors; insecure-approval waits no longer look like "API offline"; Codex `latest` no longer resolves stale or downgrades; knip-driven dead-code removal.

# 2026-05

- **Backend rewritten in Node.** The PHP backend was replaced by Node 22 / Fastify 5 / Drizzle / TypeScript under `api/`, with the HTTP contract, MySQL schema and `sbox:v1` envelopes preserved and a native `/admin/ws`.
- **Admin UI rewritten in SvelteKit.** The vanilla-JS SPA became SvelteKit + Tailwind + shadcn-svelte built into `public/admin/`, with a Cmd-K palette in place of chord shortcuts and themes cut to System / Light / Dark; eight features lost in the rewrite were restored.
- **Wrapper bakery v2 (Go).** `cdx`/`clx` became signed static Go binaries with `/wrapper/v2/*`, platform-specific artifacts (`X-Wrapper-Platform`), system installs to `/usr/local/bin` by default, startup self-update via `sudo -n install`, and `/wrapper/download` kept as a legacy transition launcher.
- **Platinum Claude Code support.** Fleet subagents, slash-commands and output-styles live in the `claude_artifacts` table; `~/.claude/settings.json` is deep-merged through `owned_paths` rather than overwritten; `claude_model_override` reaches rendered settings.
- **Claude OAuth credentials accepted.** `claudeAiOauth.accessToken` works for seeding, `/auth`, `clx auth-upload` and runner validation.
- **Removed cost tracking.** Pricing and cost history, run-cost reporting and the Claude spend-limit UI are gone.
- **Admin additions.** Quick VM throwaway hosts, host-detail **Mint installer** (`POST /admin/hosts/{id}/installer`), per-host BrowserOS MCP toggle, single-user passkey auto-prompt, and CoCo `issue`/`test` feedback types.
- **Fixes:** Codex reasoning effort normalized (`xhigh` → `high`); `codex_auth` network pinned to `172.30.250.0/24` (`CODEX_AUTH_SUBNET`); passkey login/registration, ChatGPT `/wham/usage` refresh, runner status and SPA/API route collisions repaired after the cutover.

# 2026-04

- **Claude parity push.** Runner state became engine-scoped (`runner_state_claude` …), `POST /admin/runner/run-claude` was added, API keys became strict per engine (`sk-codex-*` / `sk-claude-*`), and `docs/interface-clx.md` was introduced.
- **Engine-aware host minting.** `POST /admin/hosts/register` emits `cdx`, `clx` or combined installers; host auth tables are engine-scoped, with parallel `claude_*` host fields; admins can add the missing engine to a host.
- **Claude seeding and upload.** Engine-aware seed commands, Claude credential canonicalization into `auths["api.anthropic.com"]`, `clx auth-upload`, and per-host Claude version/model overrides.
- **`cdx auth-upload`.** Normalizes a `codex login` `auth.json` (adds `last_refresh`) and uploads it; the startup bundle uploads fresh local auth when the server reports `missing`/`upload_required`.
- **Codex floor and models.** Codex CLI floor raised to `0.120.0`; `gpt-5.5` became selectable; retired models dropped from the allowlist and force-migrated to `gpt-5.4`; `[features].memories` and `fast_mode` default on.
- **OpenAI-compatible multimodal.** `/v1/chat/completions` and `/v1/responses` keep array content parts and forward images to the runner as `codex exec --image`.
- **Admin UI "warm operator console" redesign.** Paper/Ink themes with terracotta accents and Source Serif 4 headings.
- **Fixes:** runner `/health` readiness probes; seed tokens are consumed only after a successful store; musl Codex assets on newer glibc; the `host_auth_states` PK migration crash loop; the Joplin Server flow was reworked (later removed).

# 2026-03

- **Projects / CoCo module.** Native shared-project coordination under `/admin/projects*` and `/projects*`, `project_*` MCP tools and `project://{slug}` resources, plus a managed `coco` skill; legacy CoCo aliases were removed.
- **Skills over MCP only.** Hosts read manifests through `skill://{slug}` and wrappers stop mirroring local skill files; served AGENTS gets managed `## Skills` and `## Memories` inventories; runner-backed skill drafts (`/admin/skills/generate`, `/admin/skills/assist`) and project assist.
- **Custom prompts removed.** Slash-command/custom-prompt sync is gone end to end, and wrappers prune legacy prompt directories.
- **Cron auto-update covers the wrapper.** `/cron/check` returns wrapper update instructions, `cdx --cron install` checks in immediately, and host auto-update status has derived states in the UI.
- **Admin shell moved to real paths.** `/admin/dashboard`, `/admin/hosts/{id}` etc. replace hash routes; editorial rail nav, account menu, pink themes, an AGENTS workspace with backups, a `?` shortcuts modal, and a rebuilt New Host flow.
- **Passkey hardening.** WebAuthn requires user verification, username-bound login and atomic challenges; `ADMIN_WEBAUTHN_ORIGIN` added; `scripts/admin-passkeys.php` handles recovery.
- **MCP security.** Host-authenticated `/mcp` exposes only host-safe tools, and insecure hosts get a fresh short-lived MCP bearer on each config fetch.
- **Models and config.** `gpt-5.4` and `gpt-5.4-mini` added (default `gpt-5.4`); Codex floor at `0.114.0`; `personality`, `apps`, `js_repl`, bubblewrap, `prevent_idle_sleep` and guardian-approval toggles; OpenAI `/v1/models` lists real models and `/v1/responses` was added.
- **`cdx` wrapper.** `cdx -4` launches Codex behind a local IPv4-only proxy, `cdx ls` is shorthand for the Spark lane, help passthrough skips sync, Codex release downloads require a SHA-256 digest, and there are many SSH/PTY, Bubblewrap and quota-row fixes.
- **Fixes:** a large test-coverage and PHP dedup pass; XSS escapes in the users and MCP logs tables; `/mcp` UTF-8 hardening; repeated `set -e` no-op regressions in the wrapper.

# 2026-02

- **Security and deploy hardening.** Added `TRUST_X_FORWARDED` + `TRUSTED_PROXY_CIDRS`, `PUBLIC_BASE_URL_REQUIRED`/`STRICT_HOST_VALIDATION`, a runner shared secret (`AUTH_RUNNER_SHARED_SECRET`), staged secretbox key rotation (`AUTH_ENCRYPTION_KEYS`, `AUTH_ENCRYPTION_ACTIVE_KID`), `scripts/migrate.php` with `RUN_MIGRATIONS_ON_BOOT`, and removed the un-gated `mtls-debug.php`.
- **Startup sync bundle.** `POST /sync/status` and `/sync/bootstrap` batch the startup pulls; executable JSON contracts were added under `docs/contracts/`.
- **ChatGPT quota lanes.** Normal and Spark lanes are captured from `/wham/usage`, quota enforcement follows the active lane, and `cdx lane` / `POST /host/lane` steer and persist it.
- **`cdx` status, doctor and concurrency.** Wrapper-only `cdx status` and `cdx doctor`, a host-wide active-run guard with read-only secondary runs, atomic sync writes, `NO_COLOR`/`TERM=dumb` support, macOS support, and a redesigned boot summary and run footer.
- **Admin redesign.** Dedicated `/admin/login`, host detail pages at `/admin/hosts/{id}`, left-rail Settings/Hosts/Logs, inline Chart.js graphs, and websocket-driven refresh across the SPA.
- **Models and config.** `gpt-5.3-codex` became the default, `gpt-5.3-codex-spark` was added with a strict model allowlist, and obsolete features were dropped for Codex 0.105/0.106 compatibility; `web_search` is now top-level.
- **Fixes:** insecure "Enable window" 409s; `/auth` store is always evaluated as a candidate; the run-lock is scoped per UID; MCP `startup_timeout_sec = 30`.

# 2026-01

- **Admin login and users.** Admin login, user management, roles and password recovery, with userless bootstrap while no admins exist.
- **Websocket live dashboard.** An `admin_events` table, `/admin/ws/info`, an `admin-ws` service (`ADMIN_WS_ENABLED`) and toasts for authorized/refused `cdx` calls.
- **Insecure-host approval gate.** Optional admin approval with approve/deny endpoints, wrapper wait/poll, domain auto-allow rules, IP rebinding during the window, and `INSECURE_GRACE_MINUTES` / `INSECURE_SESSION_MAX_MINUTES`.
- **Reverse DNS enforcement.** `/auth` can require forward + PTR match globally, with per-host overrides.
- **Seed command and runner-gated store.** A one-time `curl | bash` seed uploads `~/.codex/auth.json` via `/seed/auth/{uuid}`, and `/auth` store runs the auth runner before persisting.
- **AGENTS.md versioning.** Versioned storage with pinned vs latest serving and per-host pins.
- **Wrapper.** `cdx` enforces the baked FQDN (`CODEX_ALLOW_FQDN_MISMATCH=1` to override), adds `-4` for IPv4, passes reasoning effort via `--config model_reasoning_effort`, accepts token-only `auth.json`, and syncs skills as `~/.codex/skills/<slug>/SKILL.md`.
- **Fixes:** dual-stack hosts bind one IPv4 + one IPv6; stored IP columns renamed to `ip4`/`ip6`; many dashboard theme and layout passes.

# 2025-12

- **Canonical `config.toml` and AGENTS.md.** Server-managed `client_config_documents` with `/config/retrieve` (per-host baking, native HTTP `[mcp_servers.cdx]`) and `/agents/retrieve`, plus admin builders; `cdx` syncs both.
- **MCP memories.** `/mcp/memories/*` and the `/mcp` JSON-RPC server with memory/resource tools, resource templates, and an admin Memories panel.
- **Skills registry.** `/skills` endpoints and the `skills` table, managed from Settings → Skills.
- **Quota policy.** `quota_limit_percent` (50–100) with warn/hard-fail, the `quota_week_partition` daily allowance, and VIP warn-only hosts (`/admin/hosts/{id}/vip`).
- **Host controls.** Temporary hosts with a 2h idle expiry, per-host model/reasoning and Codex version overrides, a fleet Codex version pin, IPv4-only and `curl_insecure` flags, configurable inactivity pruning (0–60 days), and installation UUID enforcement.
- **Admin access.** `ADMIN_ACCESS_MODE=mtls|none` replaces `ADMIN_REQUIRE_MTLS`/`DASHBOARD_ADMIN_KEY`; passkeys were removed (later reinstated).
- **Ops.** The `mysql-backup` sidecar is on by default; runner preflight runs every ~8h; outages count as offline so cached auth stays usable.
- **Fixes:** bash 4.2 / old-glibc installer compatibility (musl assets); `cdx --uninstall`; Python 3.9 parsing; many dashboard theme iterations.

Older, verbatim entries: `git show aa09a378:CHANGELOG.md`
