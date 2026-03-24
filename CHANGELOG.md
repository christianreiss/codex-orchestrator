# 2026-03-24
- Admin UI: micro-polish on interactive elements — (1) added `transition: background 150ms ease, border-color 150ms ease, color 120ms ease` to `.config-section` sidebar buttons, which previously snapped on hover/active with no animation; (2) unified chip transition durations: both `.signal-chip` and `.chip` used mismatched staggered timings (200ms/180ms/160ms across three properties) and are now consolidated to a single `160ms ease` so all three properties animate in sync.

# 2026-03-24
- Admin UI: fixed MCP Logs timestamp display — `initMcpLogs` was rendering raw ISO timestamp strings directly (e.g. `2026-03-24T10:15:00Z`) instead of formatting them like the API Logs and Events tables do (`24.03.26, 10:15`); added `parseTimestamp`/`formatTimestamp` helpers inside `initMcpLogs` and wired them into `formatTime`, matching the pattern already used by the other two log panels; cache-bumped `logs.js` to `v=2026-03-24-03`.

# 2026-03-24
- Tests: added `ClientVersionServiceTest` with 31 unit tests covering the pure / near-pure public surface of `ClientVersionService` — `normalizeClientVersion` (null/empty/whitespace → "unknown", strips `rust-v`/`v`/`codex-cli` prefixes, trims whitespace), `applyClientVersionOverrideForHost` (null/non-string/empty/`global`/`GLOBAL` override → unchanged, valid semver override replaces client_version with `locked` source and `enforce_exact`, prefix-stripped overrides, below-minimum overrides clamped to floor, missing key → unchanged), `latestReportedVersions` (no hosts → null, all hosts lack version → null, single host → its version, multiple hosts → max semver, prefix-stripped versions compared correctly, hosts missing key skipped), `quotaLimitPercent` (null stored → default 100, valid `80` → 80, value below min clamped to 50, non-numeric → default), and `quotaWeekPartition` (null stored → default off/0, `5` → 5-day, `7` → 7-day, unrecognised value → default); `ClientVersionService` previously had zero direct test coverage.
- Backend: extracted duplicated `hostId` and `assertSha256` helpers from six sync services (`AgentsService`, `ClientConfigService`, `MemoryService`, `ProjectCoordinationService`, `SkillService`, `SlashCommandService`) into a shared `HostServiceTrait`; no behaviour change.

# 2026-03-24
- cdx wrapper: added Runner row to `--doctor` output — the doctor report now includes a "Runner" row (between MCP and API) showing the current runner state (verified, failing, stale, or disabled), with green ✅ when healthy, yellow/red coloring when degraded, and a failure hint when `runner_tone` is red; the row is omitted when runner is entirely unconfigured with no state data. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: optical polish — fixed log panel inputs (search, page-size, event filters), `.badge`, and `.token-chip` using hard-coded `rgba(15,23,42,…)` backgrounds and borders that rendered near-invisible in dark mode; switched to `var(--input-bg)` / `var(--border)` / `var(--frost)` so all themes render correctly; also constrained `#mcp-status-filter` width (was inheriting a `200px` minimum from the generic panel-actions rule, making a 3-option select unnecessarily wide).

# 2026-03-24
- Admin UI: added search and status-filter to the MCP Access Logs panel — the panel previously had only a Refresh button, while API Logs and Events both offered search/filter controls; a text search input (filters by host or tool name, Escape to clear) and a success/failure select are now wired into client-side filtering against the full loaded result set; a footer entry-count line ("N entries" / "N / M entries") mirrors the status footer used by the other log views.

# 2026-03-24
- Admin UI: visual polish — (1) sticky editorial-rail nav now uses `backdrop-filter: blur(12px)` with a slightly lower background opacity (82% → was 96%) so content scrolling beneath the nav blurs through the frosted surface, matching the depth treatment already used by cards, modals, and the login panel; (2) dashboard `input`, `select`, and `textarea` elements now animate their `border-color` and `box-shadow` properties over 180 ms so focus rings and hover border changes cross-fade instead of snapping, consistent with the login page's input transitions; both changes respect `prefers-reduced-motion`.

# 2026-03-24
- cdx wrapper: fixed `dangerously_bypass_approvals_and_sandbox = true` config setting being silently ignored — the `apply_codex_cli_toggles_from_config` helper was calling `set -- "$line" "$@"` inside a bash function body, which only modifies the function's local `$@`; the `--dangerously-bypass-approvals-and-sandbox` flag was therefore never prepended to the args passed to `codex`; replaced the function wrapper with inline script-scope logic so `set --` modifies the global positional parameters. Rebuilt `bin/cdx`.
- Admin UI: hardened `hydrateRoles` in `users.js` — role keys and labels from the server were injected into `<select>` `innerHTML` without HTML-escaping; applied `escapeHtml` to both key (`value` attribute) and label (option text content) to prevent unexpected HTML injection if server-side role metadata ever contains special characters; cache-bumped `users.js` to `v=2026-03-24-05`.

# 2026-03-24
- Tests: added `RunnerValidationServiceTest` with 61 unit tests covering pure and near-pure public methods of `RunnerValidationService` — `parseTimestamp` (null/empty/invalid/valid inputs), `calculateDigest` (null/empty → null, valid → 64-char sha256, deterministic, differs on different inputs), `ensureAuthsFallback` (auths present → unchanged, synthesizes from `tokens.access_token` / `OPENAI_API_KEY`, prefers tokens over env key, skips empty token, no-token → unchanged), `buildAuthArrayFromEntries` (structure, null-field omission, optional fields, meta spreading, alphabetical target and item key sort), `canonicalizeAuthPayload` (sets correct last_refresh and auths, preserves extra keys), `canonicalAuthFromPayload` (body-JSON branch, entries fallback when body absent or invalid), `assertReasonableLastRefresh` (valid, invalid string, implausibly old, too far future, within skew window), `normalizeAuthEntries` (single entry, organization/project, alias field names, unknown fields → meta, no-auths + fallback token, throws on empty/missing token/whitespace/short/placeholder/low-entropy token/empty target), `isRunnerFailing` (fail/FAIL → true, ok/null/empty → false), `recordRunnerOutcome` (ok → runner_state=ok + last_ok + last_check when reachable; non-ok → runner_state=fail + last_fail; last_check omitted when not reachable; case-insensitive), and `resolveRunnerHost` (hostContext with id returned directly, source_host_id lookup, fallback to first host, null when no hosts, context without id ignored); `RunnerValidationService` previously had zero direct test coverage.

- Backend: reduced code duplication in `HostRepository` — extracted a private `updateHostFields` helper that handles the common `UPDATE hosts SET … WHERE id = :id` pattern (including optional `updated_at` stamping); 15 public update methods now delegate to it, eliminating ~130 lines of repetitive prepare/execute boilerplate while preserving all existing behavior.

# 2026-03-24
- cdx wrapper: improved run exit footer — (1) a `Run summary` header line now appears above the post-run usage/cost/time/sync block, consistent with how the `--doctor` report section is headed; (2) run times under 1 second now display as milliseconds (e.g. `743ms`) instead of `0s`. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: optical polish — (1) sidebar nav tabs (hosts, logs, settings) split their combined `:hover, :focus-visible` rule so keyboard focus now shows a visible inset accent ring instead of only a barely-perceptible background tint; (2) modal inputs marked `aria-invalid="true"` restore a proper 3 px danger-tinted focus ring when focused, matching the ring size of normal field focus.

# 2026-03-24
- Admin UI: improved form validation feedback in the Users modal — (1) username is now required client-side with an inline error and `aria-invalid` highlight before hitting the server; (2) password is required for new users; (3) the confirm-password field gets the same real-time "Passwords match / Passwords do not match" hint (aria-live) already used in the account password-change form; (4) the first invalid field is auto-focused on save; (5) field error state clears on input so there's no stale red border; (6) opening the modal now moves focus to the Name field for keyboard and screen-reader users; CSS adds a red border + glow rule for `[aria-invalid="true"]` inputs inside modals.

# 2026-03-24
- Admin UI: polish — tab navigation transitions and active indicator consistency: `.host-tab` / `.log-tab` top tabs and `.hosts-nav-link.host-tab` / `.logs-nav-link.log-tab` sidebar links now animate color, border, and background changes with a 140 ms ease transition, matching the existing `.settings-tab` behavior so hover/focus state changes cross-fade instead of snapping; the active bottom-border indicator on `.host-tab.active` / `.log-tab.active` now uses `var(--accent)` instead of `var(--text)`, consistent with all other active-selection indicators in the dashboard (sidebar links, settings tabs). New selectors added to the existing `prefers-reduced-motion` block.

# 2026-03-24
- Admin UI: fixed three bugs in `users.js` — (1) delete confirmation fell through silently when `window.__confirm` was not yet defined, because the `!window.__confirm ||` short-circuit caused the whole action to return early instead of falling back to native `window.confirm`; fixed to always show a confirmation dialog; (2) edit/create API responses lacked null guards so a missing `user` object in the response would throw `Cannot read properties of null (reading 'id')` / crash the sort comparator; both now throw a clear error that is caught and shown to the user; (3) sort comparator after create guarded against null `username` with `|| ''`; cache-bumped `users.js` to `v=2026-03-24-04`.

# 2026-03-24
- Tests: added `VersionHelperTest` with 73 unit tests covering all testable public methods of `VersionHelper` — `normalizeVersionValue` (null/bool/int/array/empty/whitespace/trim/falsy-string inputs), `normalizeBoolean` (bool pass-through, int 0/1 vs other, all truthy/falsy string aliases including case-folding and whitespace trim, unrecognized/null/array/float → null), `normalizeReverseDnsModeInput` (null → global, bool/int branching, all enabled/disabled/global string aliases, case-insensitive, unrecognized → null), `formatReverseDnsModeOutput` (same mapping but unknown strings fall back to 'global' instead of null), `modelUsesSparkQuotaLane` (null/empty/whitespace → null, spark-containing model → true, non-spark → false, case-insensitive), `resolveActiveQuotaLaneForHost` (host lane-preference wins, model_override second, global cdx_model third, explicit fallback fourth, default 'normal'; VersionRepository mocked), and `extractClientVersion`/`extractWrapperVersion` (payload-first branch: value returned/trimmed/skipped when empty, null for non-array payload); `VersionHelper` previously had zero direct test coverage.
- Backend: extracted repeated ChatGPT-usage fetch-and-hydrate block in `AuthController` into a private `fetchChatGptUsage()` helper, eliminating three identical 4-line sequences across `auth`, `syncStatus`, and `syncBootstrap`.

# 2026-03-24
- cdx wrapper: `--doctor` SSH env row now only shows terminal identifier env vars that are actually set (TERM_PROGRAM, KONSOLE_VERSION, VTE_VERSION, KITTY_WINDOW_ID, WEZTERM_VERSION, WT_SESSION); unset/empty vars are silently omitted so the row stays concise on most machines instead of printing a long chain of `n/a` and empty `KEY=` entries. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: optical polish — password-change form fields in the account panel now stack label-above-input (flex column) with full-width inputs, consistent padding, and a focus ring matching the rest of the dashboard; previously the label and input rendered inline side-by-side with no width constraint. Match hint colored states (ok/err) gain `font-weight: 600` and `line-height: 1.3` for legibility at 12 px.

# 2026-03-24
- Admin UI: password change form now shows a real-time "Passwords match / Passwords do not match" hint beneath the confirm field as the user types, eliminating the need to submit the form to discover a mismatch; the hint is aria-live so screen readers announce the state change; CSS uses `--success` / `--danger` tokens for theme-aware coloring.

# 2026-03-24
- Admin UI: visual polish — `.chip` and `.signal-chip` status badges now animate background, border, and color changes with a 160–200 ms ease transition, so JS-driven state flips (e.g. secure→insecure, ok→warn) cross-fade instead of snapping; a matching `prefers-reduced-motion` block disables the new transitions for users who prefer reduced motion. Login page `card-enter` animation no longer animates `filter: blur()` — the scale + opacity entrance is equally smooth without forcing a GPU compositing layer per frame; a `prefers-reduced-motion` block on the login page now suppresses the card entrance, logo-glow, and button gradient-shift animations entirely.

# 2026-03-24
- Admin UI: fixed stale empty-state message in the Users table — when `loadUsers()` cleared the users array while a non-matching filter was still active, the empty state showed "No users match the current filter." instead of "No users yet. Create the first admin to enable login."; the fix sets the correct text before early-returning from `renderUsers()` in the empty-users branch; cache-bumped `users.js` to `v=2026-03-24-03`.

# 2026-03-24
- Tests: added `ReverseDnsValidatorTest` with 37 unit tests covering all testable public methods of `ReverseDnsValidator` — `normalizeHostname` (null/empty/whitespace/dots-only inputs, case folding, trailing-dot stripping, subdomain preservation), `reverseDnsName` (IPv4 reversal, IPv6 nibble reversal, IPv4-mapped IPv6 unwrapping, invalid/non-IP rejection), and `isReverseDnsRequired` (host-level boolean/int/string overrides, recognised string aliases like `enabled`/`yes`/`on`, fall-through to global `reverse_dns_enabled` flag via `VersionRepository`); `ReverseDnsValidator` previously had zero direct test coverage.
- Backend: extracted the duplicate version-snapshot-with-host-override block in `AuthService::handleAuth` into a private `buildVersionSnapshotForHost` method; the identical 7-line block previously appeared twice in the method (once before and once after the runner preflight path).

# 2026-03-24
- cdx wrapper: `--doctor` Sync row now renders items separated by ` | ` (e.g. `auth=ok | prompts=ok | skills=ok | agents=ok | config=ok`) instead of plain spaces, matching the visual style of the Deps row and making each sync channel easier to scan. Run-exit footer (`print_run_exit_footer`) now locally computes its own `ROW_LABEL_WIDTH` from the footer's own label set so columns align tightly to "Run usage" / "Run cost" / "Run time" / "Sync" rather than inheriting the wider pre-run summary width. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: optical polish — panel filter inputs (hosts, users, logs) now use `var(--input-bg)` instead of a hardcoded `#fff` background, so they render correctly in dark mode instead of showing as stark white boxes; sort-link column headers now animate their label color and sort-indicator opacity with a 120 ms ease transition instead of snapping instantly on click.

# 2026-03-24
- Admin UI: Users table now has a live search filter — typing in the new filter input above the table instantly narrows the list by name, username, email, or access level; pressing Escape clears the filter; a "no users match the current filter" message is shown when the filter produces no results.

# 2026-03-24
- cdx wrapper: end-of-run usage reporting now fast-paths only the last ~256 KiB of the PTY capture for a final legacy `Token usage:` line before falling back to the older full-log/session-JSONL compatibility paths, so long interactive runs no longer need a full capture scan in the common case. `/usage` upload is now explicitly best effort with roughly a 3-second total budget across SSL-context attempts, and the stripped-line retry is skipped for slow/time-out network failures so wrapper exit stays prompt. Wrapper bumped to `2026.03.24-01` and rebuilt.
- Tests/docs: added wrapper regression coverage for tail-fast-path parsing, full-log fallback when the tail misses usage, and bounded `/usage` timeout behavior; refreshed wrapper usage docs in `docs/interface-cdx.md`, `docs/USAGE.md`, and `docs/OVERVIEW.md`.

# 2026-03-24
- cdx wrapper: `format_simple_row` now wraps ANSI-colorized text on narrow terminals — previously the fold logic was skipped whenever escape codes were present, so error/warning rows in `--doctor` and `--status` output (highlighted in red or yellow) could overflow the terminal width; the new path measures visible character width via `strip_ansi_sgr` and breaks on space boundaries, keeping value columns aligned with the label pipe just as plain-text rows do. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: Users table is now sortable by Name, Username, Access level, Status, and Last login — clicking a column header toggles ascending/descending order; active column shows ▲/▼ indicators reusing the existing `.sort-link`/`.sorted` styles from the hosts table; default order remains username ascending; sort state is in-memory and resets on page load.

# 2026-03-24
- Admin UI: visual polish — removed erroneous `border-radius: 12px` from the global `:focus-visible` rule in `theme.css` and `dashboard.css`; the override was forcing all keyboard-focused elements (including pill-shaped buttons with `border-radius: 999px`) to render their focus outline as a rectangle, since modern browsers follow the element's own `border-radius` when drawing outlines; also added a subtle `scale(0.97)` and `box-shadow: none` to the global `button:active` state in `dashboard.css` for more tactile press feedback.

# 2026-03-24
- Admin UI: fixed XSS in MCP logs table — `initMcpLogs` was injecting `host_fqdn`, tool name/method, `error_message`, and `created_at` directly into `innerHTML` without escaping, while `initClientLogs` and `initEventLogs` in the same file both consistently use `escapeHtml`; added `escapeHtml` inside `initMcpLogs` and applied it to all server-sourced values at the point of injection, including the catch-block error row; cache-bumped `logs.js` to `v=2026-03-24-02`.

- Tests: added `TokenUsageTrackerTest` with 52 unit tests covering all public methods of `TokenUsageTracker` — `sanitizeUsageLine` (ANSI/OSC stripping, control-char removal, token-usage prefix extraction, truncation at 1000 chars), `normalizeCommand` (defaults, case-insensitive accept, invalid-value rejection), `normalizeUsageEntry` (all fields, line-only, numeric-only, string integers with commas/underscores, negative/invalid rejection, optional cached/reasoning), `normalizeUsagePayloads` (single entry, multiple entries, non-array skipping, empty rejection, path-in-error), and `normalizeUsageCost` (null when no billable fields, rounding to 6 decimals, NaN/negative/Inf → null, zero valid); `TokenUsageTracker` previously had zero direct test coverage.

- Backend: optimized `HostAuthDigestRepository::prune()` to use a LIMIT/OFFSET query instead of fetching all digest IDs into PHP and slicing with `array_slice`; the query now returns only the rows that fall outside the retention window, reducing unnecessary data transfer on hosts with many digest entries.

# 2026-03-24
- cdx wrapper: polished `--doctor` output — the report now closes with a trailing divider line so the block is visually bounded on both ends (previously it trailed off after the last hint); the "see hints below" suffix also uses a unicode down-arrow (↓) on unicode-capable terminals for a cleaner pointer. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: skeleton loading screens for all three log tables (API Logs, Events, MCP Logs) — replaced the plain "Loading…" text row with animated shimmer skeleton rows that reflect the column layout of each table, giving users immediate visual feedback about structure while data is fetching; respects `prefers-reduced-motion`.

# 2026-03-24
- Admin UI: visual polish — `button.secondary` now uses `var(--panel)` background and `var(--border)` border instead of hardcoded white/light-grey values, so secondary buttons render correctly in dark mode; settings sidebar tabs (`.settings-tab`) gained a `transition` on color, border-left-color, and background so hover state changes animate smoothly instead of snapping.

# 2026-03-24
- cdx wrapper: fixed two TOML inline-comment bugs — `toml_table_enabled` (used by `--doctor` MCP detection) now matches section headers that carry a trailing `# comment` (e.g. `[mcp_servers.cdx] # remark`) instead of falsely reporting the table as missing; `is_header` inside `ensure_project_path_trusted_in_config` also gained the same fix so section-boundary detection no longer overshoots when the next header has an inline comment, preventing potential `trust_level` mis-insertion in config.toml. Rebuilt `bin/cdx`.

# 2026-03-24
- Tests: added `PayloadHelperTest` with 41 unit tests covering all three public methods of `PayloadHelper` — `extractSyncAuthFingerprint` (defaults, auth-subkey extraction, digest validation/normalization, installation_id handling), `extractSyncAuthCandidate` (null/non-array inputs, missing key, valid/invalid candidate types), and `extractSyncHostUserInput` (flat vs. `host_user` subkey, whitespace trimming, partial fields, non-array subkey fallback); `PayloadHelper` previously had zero direct test coverage.

# 2026-03-24
- Backend: eliminated duplicated row-normalization logic in `TokenUsageIngestRepository` (extracted `normalizeIngestRow()`, used by both `recent()` and `search()`) and `TokenUsageRepository` (extracted `normalizeUsageRow()`, used by `latestForHost()`, `latestForHosts()`, and `recent()`); no behavior change.

# 2026-03-24
- cdx wrapper: the run exit footer now shows a "Run time" row with the elapsed session duration (seconds-precision for runs under a minute, e.g. `45s`; minutes/hours for longer runs, e.g. `2h 34m`); the footer block is also now closed with a matching divider line so it visually matches the opening divider. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: improved Profiles editor UX — deleting a profile now requires confirmation via the standard confirm dialog (shows profile name) instead of removing it silently; profile name input shows a red inline error as you type if the value contains characters outside the allowed set (`A–Z a–z 0–9 _ -`), with `aria-invalid` set for screen-reader accessibility; the error clears as soon as the name becomes valid again. Cache-bumped `profiles.js` to `v=2026-03-24-02`.

# 2026-03-24
- Admin UI: polished panel and toast entrance animations — `dashboard-hero` and `dashboard-overview-grid` now use a spring easing (`cubic-bezier(0.22, 1, 0.36, 1)`) with a slightly longer duration (500ms / 540ms) so section transitions feel snappier and more premium; toast notifications enter with a combined `translateY + scale(0.98)` from-state and the same spring easing on transform, giving them a more natural pop-in; modals gain a slightly deeper initial offset (`translateY(10px) scale(0.95)`) and spring easing on both transform and opacity for a more cohesive feel.
- Tests: fixed `CdxWrapperRunFooterTest::testWrapperFormatsRunCostWithTwoDecimalsAndCurrencySuffix` — the test was still asserting the old `%.2f$` (dollar-suffix) format string after the wrapper cost display was changed to `printf '$%s'` (dollar-prefix) with separate 2/4-decimal formatting; renamed the test to `testWrapperFormatsRunCostWithCurrencyPrefixAndVariableDecimals` and updated its assertions to match the current `format_run_cost_value` implementation (`printf '$%s'`, `%.4f` for sub-cent, `%.2f` otherwise).
- Tests: added `InsecureHostWindowServiceTest` with 34 unit tests covering all public methods of `InsecureHostWindowService` — `isTimestampActive`, `parseSessionStartedAt`, `resolveInsecureGraceUntil` (including env-override and max-clamp cases), and `enforceInsecureWindow` (secure pass-through, active window, grace-window store/retrieve distinction, fully-expired denial, and exception payload shape); `InsecureHostWindowService` previously had zero direct test coverage.
- cdx wrapper: fixed run cost display — cost is now formatted as `$1.23` (dollar sign before the amount) instead of the previous `1.23$`; values below $0.01 now display four decimal places (e.g. `$0.0012`) rather than rounding to `$0.00`. Rebuilt `bin/cdx`.

- Admin UI: added `n` keyboard shortcut to open the "new item" modal for the current panel — Hosts → New Host, Users → Add User, Settings/Slash Commands → New Command, Settings/Skills → New Skill; shortcut is listed in the `?` help modal alongside the existing `r` / `/` / `g+x` shortcuts.
- Admin UI: visual polish — nav rail hover indicator now expands to full width at reduced opacity (`scaleX(1)`, 32%) instead of the previous partial-width ghost (`scaleX(0.65)`, 28%), so hover→active is a smooth opacity-only transition; rail link text colour transition harmonized from 120ms to 160ms to match the underline timing; focus rings on modal and panel-action inputs unified to use the canonical `var(--ring)` box-shadow token (replacing inconsistent `outline: 1px solid var(--accent)`) and switched to `:focus-visible` so keyboard-only rings don't appear on mouse click.
- cdx wrapper: fixed `find_block()` in `otel_env_from_config_python` and `codex_cli_args_from_config_python` so TOML section headers with inline comments (e.g. `[otel] # my settings`) are now matched correctly; previously the regex `\]\s*$` did not accept a `#`-prefixed comment after the closing bracket, causing OTEL environment variables and `dangerously_bypass_approvals_and_sandbox` to be silently ignored when the user had a comment on the section header line. Rebuilt `bin/cdx`.
- Tests: added `ProjectNormalizerTest` with 62 unit tests covering all public methods of `ProjectNormalizer` — `normalizeSlug`, `normalizeAbout`, `normalizeRoster`, `normalizeNotePayload`, `normalizeTodoPayload`, `normalizeFilePayload`, `normalizeFeedbackPayload`, `normalizeStoredName`, and `normalizeOptionalString`; `ProjectNormalizer` previously had zero test coverage.
- Backend: eliminated N+1 query pattern in `GET /admin/hosts` — added `TokenUsageRepository::latestForHosts()` and `HostUserRepository::listByHosts()` batch methods that fetch token-usage and user rows for all hosts in two queries instead of two-per-host; `AdminOverviewController::hosts()` now uses these batch methods and also hoists the `$normalizeTs` closure out of the per-host loop.
- cdx wrapper: colorized individual sync status tokens in the `--doctor` Sync row — each status value (`ok`, `offline`, `concurrent`, etc.) is now rendered green/yellow/red instead of plain text, making it faster to spot failures at a glance. Rebuilt `bin/cdx`.

- Admin UI: unsaved-changes guard for config.toml and Profiles editors — navigating away via SPA links now shows a browser confirm dialog when either editor has uncommitted edits; closing/reloading the tab also triggers the native `beforeunload` prompt; dirty state is cleared automatically on successful save or reload; cache-bumped `dashboard.js` to `v=2026-03-24-03`, `config.js` to `v=2026-03-24-01`, `profiles.js` to `v=2026-03-24-01`.
- Admin UI: polished nav rail affordances — non-active nav links now show a faint partial underline on hover (28% opacity, 65% scale, accent colour) so the active-state indicator is telegraphed before click; the nav group dropdown panel gains a proper elevation shadow (`0 8px 24px rgba(2,6,23,0.14)` + 1px accent ring overlay) instead of being flat against the background. Cache-bumped `dashboard.css` to `v=2026-03-24-02`.
- cdx wrapper: fixed heuristic TOML validator in `--doctor` so section headers with inline comments (e.g. `[otel] # remark`) are no longer falsely reported as parse errors on Python < 3.11 without `tomli`; the fix strips the inline comment portion before the closing-bracket check. Rebuilt `bin/cdx`.
- Tests: added `ConfigNormalizerTest` with 114 unit tests covering all public methods of `ConfigNormalizer` — `normalizeString`, `normalizeBool`, `normalizeWebSearchFeature`, `normalizeApprovalPolicy`, `normalizePersonality`, `normalizeReasoningSummary`, `normalizeReasoningEffortForModel`, `normalizeInt`, `normalizeStringList`, `normalizeStringMap`, `normalizeSupportedModel`, `modelSupportsReasoningEffort`, `isSparkCodexModel`, `isDetailedOnlyCodexModel`, `normalizeModelVerbosity`, `settingsHash`, `assertSha`, and a full `normalizeSettings` integration suite; `ConfigNormalizer` previously had zero test coverage.
- Backend: reduced code duplication in `LogRepository` — extracted `buildInClauseParams()` and `normalizeActions()` private helpers so the identical IN-clause construction logic shared between `recentByActions()` and `countActionsSince()` lives in one place; added `@param`/`@return` PHPDoc annotations on the new helpers for static-analysis clarity.


- cdx wrapper: improved `--doctor` hints formatting — hints are now rendered as aligned table rows using `format_simple_row` (`Hint N  | <text>`) instead of loosely indented `  Hint N: <text>` lines, making them visually consistent with the rest of the doctor report table and enabling the existing long-line wrapping logic to apply correctly.
- Admin UI: polished interactive element transitions — default buttons now use `var(--panel)` background (theme-aware, fixes invisible text on white in dark mode), gain a `1px` lift with a soft accent shadow on hover, and snap back on press via a unified `transition` on the overhaul layer; `.ghost` buttons pick up an accent-tinted hover; nav rail active-tab underline now springs in from the center with a scale + spring easing (`cubic-bezier(0.34, 1.56, 0.64, 1)`) instead of a plain opacity fade.
- cdx wrapper: fixed Python regex in `find_block` (used by both `otel_env_from_config_python` and `codex_cli_args_from_config_python`) where raw-string double backslashes (`r'\\['`) were parsed by the regex engine as "literal backslash + character class" instead of "literal `[`", so `[otel]` and `[security]` TOML section headers were never matched — OTEL environment variables and `dangerously_bypass_approvals_and_sandbox` were silently ignored even when configured; fixed by using single-backslash raw strings (`r'\['`, `r'\]'`, `r'\s'`). Rebuilt `bin/cdx`.
- Tests: fixed `CdxWrapperSshKeyboardFilterTest::testDoctorReportsInteractiveSshDirectLaunchMode` which was checking for the removed `Doctor ssh`/`Doctor cli` label prefixes instead of the current `"SSH env"`/`"CLI"` format introduced in the 2026-03-24 doctor refactor.
- Tests: added `TomlRendererTest` with 50 unit tests covering `buildToml` (root keys, notify, features, notice, security, sandbox, shell env policy, profiles, mcp_servers, otel, custom_toml), `escapeString`, `tomlString`, `normalizeHomePath`, and `injectTrustedProjectToml` — `TomlRenderer` previously had no test coverage.

- cdx wrapper: improved `--doctor` output readability — added a divider and "Doctor report" section header, replaced the redundant "Doctor " prefix on every label with short clean names (`Deps`, `Auth`, `Sync`, `Config`, `MCP`, `API`, `Latency`, `Disk`, `Cron`, `PTY`, `SSH env`, `CLI`), added a `Result` summary line showing pass/fail count, numbered and reformatted action hints (`Hint N: …`), and dynamically recompute the label column width within the doctor section.
- Admin UI: added keyboard shortcuts for the admin dashboard — `g`+`d/h/l/s/u/a` navigate between panels, `/` focuses the active search/filter input, `r` clicks the current view's refresh button, and `?` opens a keyboard shortcuts help modal; cache-bumped `dashboard.js` to `v=2026-03-24-01` and `dashboard.css` to `v=2026-03-24-01`.
- Admin UI: fixed `r` keyboard shortcut refresh on the Hosts and Dashboard panels (was incorrectly triggering a version-check instead of a live data refresh) and on the Logs panel (now only clicks the refresh button of the currently-visible log sub-panel instead of always clicking API logs' refresh regardless of active tab); bumped `dashboard.js` to `v=2026-03-24-02`.
- Admin UI: polished button micro-interactions — dashboard buttons now lift `1px` on hover with a subtle accent shadow (matching the login page's established tactile style) and snap back cleanly on press; transition timing made uniform at `150ms cubic-bezier(0.2,0,0,1)`. Toggle switch thumbs replaced hardcoded dark-blue gradients with a neutral off-state (`#e2e8f0`) and the theme accent gradient for the on-state, so toggles now adapt to both dark and light themes.

# 2026-03-21
- cdx wrapper/setup: replaced the old `Codex Coordinator` startup ASCII art with the new `codex orchestrator` banner in the wrapper and quick-setup flow, then bumped the wrapper to `2026.03.21-02`.
- Admin UI: removed the dead `uPlot` chart path and orphaned assets, leaving the SVG quota/cost history renderer as the only supported dashboard history implementation; cache-bumped the touched admin JS/CSS bundles.
- Admin UI: fixed the `Active Windows` modal again so it respects the server-provided insecure-window active state, keeps closed insecure hosts visible with a `Window closed` status, and allows in-place re-enable/disable actions without leaving the modal.
- cdx wrapper/dev tooling: split the baked wrapper’s large embedded Python/config fragments into dedicated `bin/cdx.d/` subfragments, rebuilt `bin/cdx`, and added repo guardrails for PHPStan, shell linting, dependency-audit, contract tests, and generated-wrapper verification. Wrapper bumped to `2026.03.21-01`.

# 2026-03-20
- Model support: added `gpt-5.4-mini` across the fleet config/admin host override allowlists, config builder, profiles UI, and docs, with `low|medium|high|xhigh` reasoning-effort support; cache-bumped the touched admin JS bundles.

# 2026-03-19
- Admin UI: removed the duplicate secondary page nav strip (`Overview`, `Hosts`, `Logs`, `Settings`, `Users`) from the admin shell, leaving the main header/editorial rail as the only top-level navigation.
- Admin UI/hosts: fixed a `dashboard.js` syntax error in the host detail action bar that stopped the admin bundle from loading; host detail fields such as `WebUI Admin Port` now populate again. Cache-bumped `dashboard.js` to `v=2026-03-19-03`.
- cdx wrapper: hardened root detection for self-update management by falling back to `id -u` alongside Bash `EUID`, and the `Versions` summary now reports the detected UID when Codex update checks are skipped for lack of privileges. Wrapper bumped to `2026.03.19-03`.
- Admin UI: tightened the `Active Windows` modal again so it now shows only currently enabled insecure hosts and active domain allows; disabled host windows and inactive domain entries disappear immediately after refresh/revoke instead of lingering in the quick-action list.
- Admin UI/auth: restored the dedicated upper-right account menu and now bootstrap it directly from the already-authenticated PHP admin session, so the signed-in name, password/passkey links, and logout action no longer disappear from the header when the follow-up `/admin/auth/status` refresh call hiccups.
- Admin UI: fixed the `Active Windows` modal so `Disable all` no longer makes the host rows disappear; insecure hosts now remain visible in the modal after shutdown, show an explicit `Window closed` state, and can be re-enabled in place without leaving the view.

# 2026-03-18
- Admin UI/auth: turned the navbar brand into an account menu with nested theme selection plus `Password change`, `Passkeys`, and `Logout`; moved personal passkey management out of `Users` into new `/admin/account/{password,passkeys}` pages; added self-service `POST /admin/auth/password/change`; and replaced direct logout with a confirmation modal.
- Admin UI: reimagined the insecure-host navbar quick action into `Active Windows`, which now appears only when at least one insecure host window is currently enabled; the modal now lists only active hosts for quick disable, keeps allowed-domain revoke controls, removes the old enable/extend flow, and cache-bumps `dashboard.js`.
- Admin UI: fixed the editorial rail desktop dropdowns so the first pointer click on `Hosts`, `Logs`, or `Settings` now stays open instead of opening on focus and immediately toggling shut; keyboard focus still auto-opens the menus.
- Admin UI: compacted the editorial rail to reclaim vertical space by reducing the header padding, inner frame height, and rail item heights on desktop/mobile, so the navbar wastes less white space while keeping the same flattened menu styling.
- Admin UI: removed the last button/pill chrome from the editorial rail controls so `Hosts`, `Logs`, `Settings`, `New Host`, `Theme`, and logout now render as plain rail text/actions without bordered capsules, separator seams, or shadowed button surfaces.
- Admin UI: flattened the editorial rail further by removing the remaining navbar/flyout box shadows and switching the custom focus treatment from shadow rings to simple outlines, so the whole header reads as one flat surface.
- Admin UI: replaced the previous 2026 navbar with a clean-sheet editorial rail menu system: brand, destinations, utilities, and account controls now sit in one matte rail, desktop flyouts were rebuilt from scratch (`Hosts`, `Logs`, grouped `Settings`), the mobile nav now uses a full-height rail drawer, and the old chip/glass/button-heavy nav controller was retired entirely.
- Admin UI: removed the last pill/bubble treatment from the desktop `Hosts`, `Logs`, and `Settings` dropdown parents so they now sit as plain menu labels inside the unified header bar, with underline/open-state feedback instead of contained chips.
- Admin UI: tightened the 2026 main navbar into one unified menu shell, grouped utility controls into a shared cluster, removed the remaining bubble/pill treatment from primary nav items and header actions, and refreshed the desktop/mobile drawer styling so the whole header reads as one polished system.
- Admin UI: redesigned the top navigation from a row of separate rounded buttons into one unified app menu bar — primary nav items now use bottom-indicator active states instead of pill backgrounds, utility/action controls are visually separated from primary navigation, and the header reads as one cohesive surface rather than a collection of floating controls. Added `aria-current="page"` for active route accessibility.
- MCP/runner security: host-authenticated `/mcp` now exposes only host-safe memory/resource/project tools and no longer advertises or dispatches coordinator filesystem `fs_*` helpers; runner verification payloads were trimmed to the fields the runner actually consumes, and the MCP/runner docs were tightened to match.
- Admin UI: refreshed the 2026 desktop nav into a tighter macOS-style command bar with dropdown menus for Hosts, Logs, and Settings, restored mobile tab fallbacks inside the drawer, and cache-bumped the dashboard stylesheet.
- Admin UI: switched the dashboard shell from hash fragments to real `/admin/...` paths (`/admin/dashboard`, `/admin/hosts/*`, `/admin/logs/*`, `/admin/settings/*`, `/admin/projects/{slug}`, `/admin/users`), updated the path bootstrap/init helpers, and cache-bumped the touched admin JS bundles so reloads and deep links stay in sync.
- cdx wrapper/auth contracts: `/auth` and `/versions` now expose `versions.auto_update_enabled`, and host-level `auto_update_override` now tells `cdx` to skip per-run update checks when cron-managed auto-update is already enabled. Wrapper bumped to `2026.03.18-03`.
- Admin hosts: fixed `/admin/hosts` so it also returns `last_cron_check`, which lets the dashboard host detail show real cron auto-update check-ins instead of falling back to `Never` after successful `cdx --cron` runs.
- cdx wrapper: fixed `cdx --cron` HTTPS verification to reuse the wrapper’s relaxed Python SSL-context setup (`VERIFY_X509_STRICT` fallback disable plus explicit insecure-mode fallback), so cron auto-update checks no longer fail on hosts whose internal CA chain is accepted by curl/OpenSSL but rejected by newer Python TLS validation. Wrapper bumped to `2026.03.18-02`.
- Skills/AGENTS: the server now auto-seeds canonical AGENTS storage from the checked-in repo `AGENTS.md` on boot, so fleet MCP-first skill guidance is actually served instead of drifting in MySQL. Skill/admin/startup-sync payloads now also expose canonical `skill://{slug}` metadata plus fallback paths for clients that need to render the correct preference order.
- cdx wrapper: hardened `cdx --cron` installs by quoting wrapper/log paths, escaping cron `%` semantics, narrowing remove/install matching to the managed/current wrapper entry, degrading cleanly when `flock` is unavailable, retrying `/cron/report`, and failing closed on mismatched platform release assets. Wrapper bumped to `2026.03.18-01`.
- Host pruning: `/cron/check` now records only `last_cron_check`, so stray cron pings no longer refresh host `updated_at` and keep inactive/decommissioned hosts alive.
- Ops: slimmed `scripts/refresh-chatgpt-usage.php` down to quota-refresh work only and switched `quota-cron` health from a DB probe to a heartbeat-driven success signal.

# 2026-03-17
- Admin passkeys: fixed WebAuthn RP ID/origin fallback so admin login now prefers the canonical `PUBLIC_BASE_URL` host/origin when explicit `ADMIN_WEBAUTHN_*` overrides are unset, avoiding request-host drift behind proxies after restarts.
- Admin UI: unified the login page, dashboard shell, and admin access/error screens behind one shared theme layer with local fonts, matching glass surfaces, and themed HTML responses for mTLS/UI load failures.
- Skills/docs/admin: switched fleet guidance to a `cdx`-first model so Skills are now documented as canonical via MCP `skill://{slug}`, with synced `~/.agents/skills/<slug>/SKILL.md` copies treated as fallback-only compatibility files.
- Admin login: switched `/admin/login` to a username-first single-button flow, added `/admin/auth/login/method`, and now require passkey-enabled admins to use passkeys instead of falling back to password login.
- Admin passkeys: hardened passkey login/registration error handling so malformed WebAuthn payloads now return explicit 4xx errors instead of falling through as HTTP 500 `Unexpected error` on the login page.
- Admin hosts: fixed `/admin/hosts` so it returns each host’s `auto_update_override`, which keeps the Cron auto-update toggle from snapping back to the fleet-default visual state right after a save.
- Ops: added `scripts/export_ai_bundle.sh` to export repo-scoped AI debugging bundles for the app, wrapper, and runner surfaces, with canonical docs/tests included and secrets/runtime noise excluded.
- Admin passkeys: hardened WebAuthn policy so registration/login now require user verification (`UV`), login is username-bound via `allowCredentials` instead of username-less discoverable credentials, and registration no longer forces platform-only authenticators.
- Admin passkeys: fixed sign-counter handling so regressions log `admin.auth.passkey.sign_count_regression`, never reduce the stored counter, and still update `last_used_at`.
- Admin passkeys: made WebAuthn challenge consumption transactional/atomic, added explicit `ADMIN_WEBAUTHN_ORIGIN` support, and refreshed admin/API/login/interface docs to match the implemented passkey surface and default mTLS boundary.
- Admin ops: added `scripts/admin-passkeys.php` for Docker/Compose recovery so operators can delete an admin user’s stored passkeys without manual database edits.

# 2026-03-16
- Projects/CoCo: fixed project coordination error handling so missing/disabled project paths return proper HTTP 404/500 responses instead of crashing on reversed `HttpException` arguments, and added MCP `project_create` so `#coco` can bootstrap fresh shared slugs without raw REST fallback.
- MCP skills: `/mcp` now exposes read-only `skill://{slug}` resources for synced Skill manifests, so remote Codex clients can read managed skills like `coco` without assuming a local `~/.agents/...` path.
- cdx wrapper: fixed macOS Bash 3.2 launch paths after the IPv4-proxy wrapper update by avoiding empty `cmd_prefix` / proxy argv array expansion under `set -u`, which previously crashed `cdx ls` and other Codex launches with `unbound variable` before Codex started. Wrapper bumped to `2026.03.16-01`.
- CoCo cleanup: removed the temporary server-side retirement hook for the old `CoCo Toolkit` record and deleted the already-retired legacy DB row, leaving only the managed project-native `coco` skill in code and storage.
- Projects/CoCo cleanup: removed the temporary legacy `/project/*`, `/bootstrap`, `/b/{slug}`, and `/p/{slug}` compatibility routes again so CoCo is once more strictly project-native on `/projects/*`.
- Skills cleanup: the server now auto-retires the old stored `skills.slug = "coco"` / `CoCo Toolkit` database document by signature, leaving the managed project-native `coco` skill as the only active CoCo skill surface.
- Docs/tests: removed the temporary legacy CoCo alias docs again and flipped the router coverage so the new project-native surface stays the only supported path.

# 2026-03-15
- cdx wrapper: extended `force_ipv4` / `cdx -4` so the wrapper now launches Codex behind a short-lived local IPv4-only proxy, making Codex-side `chatgpt.com` traffic honor IPv4-only hosts in addition to the wrapper’s own sync/update calls. Wrapper bumped to `2026.03.15-01`.

# 2026-03-14
- cdx wrapper: fixed `cdx ls` / `cdx lane` on macOS Bash 3.2 by avoiding empty-array argv reset under `set -u`, which previously crashed with `lane_passthrough[@]: unbound variable` before Codex launched. Wrapper bumped to `2026.03.14-01`.
- ChatGPT usage refresh: fixed `scripts/refresh-chatgpt-usage.php` to match the current `AuthService` wiring so the `quota-cron` worker boots cleanly after the Codex version-floor changes and can keep refreshing usage snapshots.

# 2026-03-13
- Codex version policy: added an internal minimum Codex CLI floor at `0.114.0`; fleet and host pins below that are coerced upward, `/auth` and `/versions` now expose `client_version_enforce_exact`, and `cdx` only downgrades when that flag is true for an above-floor exact pin. Wrapper bumped to `2026.03.13-03`.
- cdx wrapper: restored usage capture for Codex `0.114.0+` by resolving the emitted `session id` to `~/.codex/sessions/.../*.jsonl` and reading structured `token_count` usage rows, with fallback to the new `tokens used` footer and the older `Token usage:` line format. Wrapper bumped to `2026.03.13-01`.
- Usage API/docs/tests: `/usage` now leaves `cost=null` when clients only report total tokens without billable input/output/cached splits, preventing misleading `0.00$` run-cost displays while still recording usage totals.

# 2026-03-13
- Projects/CoCo cross-server guardrails: CoCo shared handoffs are now explicitly project-only in the managed `coco` skill, bootstrap payloads, API/admin copy, and MCP docs; host-scoped `memory://...` resources are no longer described as a valid fallback for shared CoCo state.
- MCP memories: reserved keys matching `^coco(?:$|[._:-])` are now rejected with a validation error so cross-host CoCo handoffs cannot be mis-modeled in `mcp_memories`, which remain host-scoped by design.
- cdx wrapper: skill pull sync now removes stale legacy managed copies under `~/.codex/skills/<slug>` so an old pre-project `coco` skill cannot shadow the managed `~/.agents/skills/coco/SKILL.md` rollout on upgraded clients. Wrapper bumped to `2026.03.13-02`.

# 2026-03-12
- Projects/CoCo module: the managed `coco` skill now embeds the native CoCo toolkit/help directly, and project bootstrap payloads now point agents to that skill instead of a separate help page.
- cdx wrapper: managed skills that disappear from the remote list are now pruned locally on sync, so disabling the Projects module removes the auto-managed `coco` skill from clients on their next pull. Wrapper bumped to `2026.03.12-02`.
- Projects/CoCo module: added a native shared-project coordination module with admin + host REST routes under `/admin/projects*` and `/projects*`, covering project creation, about/roster updates, shared notes, todos, files, feedback, and append-only activity history.
- MCP + client rollout: `/mcp` now exposes project-aware tools/resources (`project_*`, `project://{slug}`) when the module is enabled, and enabling the module auto-publishes a managed `coco` skill to Codex clients through the normal Skills sync path.
- cdx wrapper: managed project skills now keep `managed` metadata in the Skill baseline and are skipped during wrapper-side `/skills/store` pushback, so the auto-deployed `coco` skill stays read-only on clients without generating noisy sync errors. Wrapper bumped to `2026.03.12-01`.
- Admin/UI/docs/tests: compressed Settings → Projects into a compact index with Open/Delete actions, moved the full project editors onto a dedicated `#project-detail/<slug>` admin page, marked the managed `coco` skill read-only in the Skills UI, corrected Skill sync copy to `~/.agents/skills/<slug>/SKILL.md`, and refreshed API/admin/MCP/interface docs plus regression coverage.

# 2026-03-11
- Config builder/model default: switched new top-level config drafts and new profile drafts from `gpt-5.3-codex` to `gpt-5.4`, cache-bumped both admin builder assets, and refreshed the config-builder docs/example payloads.
- Config builder/default matrix: changed the fleet config defaults so only `apps` and `multi_agent` stay on by default, while `guardian_approval`, `js_repl`, `use_linux_sandbox_bwrap`, and `prevent_idle_sleep` now start off until explicitly enabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/prevent-idle-sleep: added a first-class `Prevent sleep while running` toggle and defaulted `[features].prevent_idle_sleep = true` in normalized/rendered `config.toml`, so Codex keeps the computer awake during active threads unless explicitly disabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/guardian approval: added the upstream `Automatic approval review` feature as a first-class toggle, added `guardian_approval` to the supported feature allowlist, and defaulted `[features].guardian_approval = true` in normalized/rendered `config.toml`, so `on-request` approval prompts can be routed through the security reviewer subagent by default; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/bubblewrap: added a first-class Bubblewrap sandbox toggle and defaulted `[features].use_linux_sandbox_bwrap = true` in normalized/rendered `config.toml`, so the new Linux bubblewrap sandbox is enabled fleet-wide unless explicitly disabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/js_repl: added a first-class JavaScript REPL toggle and defaulted `[features].js_repl = true` in normalized/rendered `config.toml`, so the persistent Node-backed JS REPL is enabled fleet-wide unless explicitly disabled; admin copy/docs now call out the Node `>= v22.22.0` requirement, and the config builder asset was cache-bumped with refreshed tests.
- Config builder/apps: added a first-class ChatGPT Apps toggle and defaulted `[features].apps = true` in normalized/rendered `config.toml`, so `$` App usage is enabled fleet-wide unless explicitly disabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- cdx wrapper: fixed self-update restart on CentOS 7 / XCP-NG Bash 4.2 by snapshotting the original argc separately from argv, so no-arg wrapper re-execs and lock metadata formatting no longer trip `set -u` on empty-array expansion; wrapper bumped to `2026.03.11-02`.
- cdx wrapper: added `cdx ls` as shorthand for `cdx lane spark` (including `--persist` and passthrough args) so hosts can jump into the Spark lane with a shorter command. Wrapper bumped to `2026.03.11-01`.

# 2026-03-10
- cdx wrapper: interactive SSH sessions now bypass wrapper PTY capture and launch Codex directly unless `CODEX_FORCE_PTY=1`, avoiding stacked-PTY rendering/input issues on hosts like `lims`; `cdx doctor` now reports `ssh-launch=direct-tty|pty-forced`, and wrapper-side usage capture may be unavailable for those SSH runs. Wrapper bumped to `2026.03.10-10`.
- cdx wrapper: removed the interactive SSH keyboard compatibility bridge and the `CODEX_SSH_KEYBOARD_FILTER` toggle, returning SSH launches to the standard PTY/direct execution paths after the bridge caused more trouble than it solved. Wrapper bumped to `2026.03.10-09`.
- cdx wrapper: fixed the SSH keyboard bridge input parser so plain `Enter` bytes are normalized to carriage return and non-CSI-u escape sequences pass through instead of stalling in the pending-input buffer; this restores prompt submission over SSH while keeping arrow/paste-style sequences from wedging input. Wrapper bumped to `2026.03.10-08`.
- cdx wrapper: fixed the SSH Python PTY paths to copy the real terminal window size into child PTYs and forward `SIGWINCH`, preventing Codex from rendering one character per line after the bridge/fallback started the UI on SSH hosts. Wrapper bumped to `2026.03.10-07`.
- cdx wrapper: fixed the interactive SSH keyboard bridge to bind input from `/dev/tty` instead of the heredoc-backed `stdin`, and keep draining the child PTY even if wrapper input goes idle; this stops plain SSH launches from immediately dropping back to the shell on insecure hosts (and other bridge-enabled SSH sessions). Wrapper bumped to `2026.03.10-06`.
- cdx wrapper: fixed insecure-host one-shot runs by deferring `--execute` launch into the normal authenticated startup path (sync/auth/update/gates) instead of short-circuiting before `/auth`; this prevents immediate unauthenticated exits after post-run `auth.json` purge. Wrapper bumped to `2026.03.10-05`.
- cdx wrapper: when a wrapper version update is pending, Codex binary update now defers until the post-restart pass so one invocation no longer installs two different Codex versions back-to-back (for example `0.113.0` then `0.112.0`); wrapper bumped to `2026.03.10-04`.
- cdx wrapper: pre-launch now idempotently force-trusts the active working directory (plus `pwd -P` when it differs) in local `~/.codex/config.toml`, preventing repeated interactive "Do you trust this directory?" prompts after Codex `0.113.0`; wrapper bumped to `2026.03.10-03`.
- Config builder/personality: added root `personality = "friendly"|"pragmatic"|"none"` support to fleet-managed `config.toml`, defaulted new/existing configs to `friendly`, and added optional profile-level overrides that inherit the root value when unset.
- Admin/docs/tests: added a dedicated config-builder personality selector, profile override control, cache-bumped `config.js`/`profiles.js`, updated config/interface docs, and expanded `ClientConfigService` coverage for root/profile personality rendering.
- cdx wrapper: replaced the earlier SSH version pin with an interactive-SSH keyboard compatibility bridge that strips Codex kitty keyboard enable/disable sequences and normalizes CSI-u Enter/Ctrl keys before launch, so prompts submit again over SSH without changing the installed Codex version. `cdx doctor` now reports SSH terminal hints plus bridge state. Wrapper bumped to `2026.03.10-02`.
- Installer/docs/tests: installer no longer downgrades Codex on SSH; wrapper/interface docs were updated for the SSH keyboard bridge, and regression coverage now locks the bridge/doctor strings into the built wrapper and installer template.

# 2026-03-09
- Config retrieve/render fix: `notice.model_migrations` now merges saved maps with default migrations, so legacy stored configs that only had `gpt-5.2-codex -> gpt-5.3-codex` also receive `gpt-5.3-codex -> gpt-5.4` and stop surfacing the interactive GPT-5.4 upgrade chooser.
- Config builder/template defaults: added `notice.model_migrations` mapping `gpt-5.3-codex -> gpt-5.4` (alongside `gpt-5.2-codex -> gpt-5.3-codex`) so Codex `0.112.0+` upgrade prompts are auto-resolved from fleet-managed `config.toml`.
- Admin UI/docs/tests: updated config-builder defaults, cache-bumped `config.js`, refreshed config/interface docs, and expanded `ClientConfigService` assertions for the new migration mapping.
- Codex `0.112.0` compatibility audit: feature normalization now drops removed/unknown `features.*` keys and keeps only currently supported Codex feature flags (while still mapping deprecated `web_search_request`/`web_search_cached` into root `web_search`).
- Admin config UI/docs: replaced stale feature toggles with current valid defaults (`fast_mode`, `unified_exec`, `voice_transcription`, `multi_agent`) and updated feature docs/contracts accordingly.

# 2026-03-06
- Security/wrapper: insecure-host baked `config.toml` no longer persists a reusable managed MCP host API key; secure hosts still use the host API key, while insecure hosts now receive a short-lived MCP bearer token backed by the new `mcp_session_tokens` store.
- cdx wrapper: hardened GitHub release-asset Codex updates by requiring a trusted SHA-256 digest from release metadata before install; missing or mismatched digests now skip the binary update instead of installing unchecked content. Wrapper bumped to `2026.03.06-03`.
- cdx wrapper: fixed deleted-skill startup sync by importing `shutil` in the embedded Python used by `skill_sync_python()`.
- Docs/tests: updated API/config/db/wrapper docs plus regression coverage for insecure-host managed MCP baking, MCP bearer auth wiring, checksum-enforced Codex updates, the new MCP token table, and deleted-skill sync imports.
- Admin dashboard: fixed `/admin/overview` crashing with `HTTP 500 {"status":"error","message":"Unexpected error"}` by restoring the `$pricingModel` closure capture before pricing lookup; added regression coverage for the route signature.
- cdx wrapper: fixed concurrent/read-only quota hydration parsing so missing `chatgpt_usage` payloads no longer break metadata refresh and numeric-string quota fields are accepted, restoring quota bar rendering when usage metadata is returned as strings; wrapper bumped to `2026.03.06-02`.
- Model support: added `gpt-5.4` to the config builder and per-host override allowlists across the API, admin UI, and validation logic, with full `low|medium|high|xhigh` reasoning-effort support.
- Pricing defaults: cost snapshots/backfills/overview calculations now target `gpt-5.4` by default and prefer `GPT54_*` env fallbacks while still honoring legacy `GPT51_*` values for backward compatibility.
- Docs/tests: refreshed interface/install/admin/README notes for the new model and pricing defaults, and added coverage for `gpt-5.4` config validation plus pricing fallback precedence.
- cdx wrapper: help-only invocations now bypass wrapper MOTD/sync/quota/footer noise and pass straight through to the real Codex CLI, so `cdx --help`, `cdx -h`, `cdx help`, and Codex subcommand help (for example `cdx exec --help`) print only upstream help text; wrapper bumped to `2026.03.06-01`.
- Docs/tests: updated wrapper interface/overview docs and added regression coverage for the early help passthrough path.

# 2026-03-05
- cdx wrapper: spark reasoning-summary guard now resolves the effective model from top-level `config.toml` defaults (including explicit profiles that inherit the root model), and execute-mode passthrough selectors (`--model` or `--profile`) now resolve Spark models the same way and inject root/profile `model_reasoning_summary=none` overrides; this closes remaining `reasoning.summary` leaks on both normal and execute paths; wrapper bumped to `2026.03.05-01`.

# 2026-03-03
- Wrapper seeding hardening: `WrapperService` now serves bundled `bin/cdx` as a fallback when `storage/wrapper/cdx` drifts but cannot be overwritten (for example ownership/capability mismatches), and logs an explicit warning instead of silently serving stale wrapper content.
- Tests/docs: added `WrapperService` coverage for non-writable storage fallback and updated wrapper source semantics in `interface-api`/`OVERVIEW` docs.

# 2026-03-02
- cdx wrapper: `cdx lane spark -- --execute "<prompt>"` now honors lane selection in execute mode (profile-first, spark-model fallback) instead of hardcoding `gpt-5.3-codex`, and applies both root/profile spark summary guards to avoid `reasoning.summary` 400s; wrapper bumped to `2026.03.02-04`.
- cdx wrapper: spark summary safeguard now also overrides profile-scoped summary keys (`profiles.<name>.model_reasoning_summary=none`) when a spark model is selected via profile, preventing `reasoning.summary` leaks from legacy profile configs; wrapper bumped to `2026.03.02-03`.
- cdx wrapper: spark summary safeguard is now profile-aware; when `lane spark` (or explicit `--profile`) resolves to a profile whose model is `gpt-5.3-codex-spark`, wrapper injects `--config model_reasoning_summary=none` and avoids OpenAI 400 `unsupported_parameter` (`reasoning.summary`) failures; wrapper bumped to `2026.03.02-02`.
- cdx wrapper: hard-cut Skill sync local path from `~/.codex/skills` to `~/.agents/skills` (baseline moved from `~/.codex/.skill-baseline.json` to `~/.agents/.skill-baseline.json`), and removed flat-file Skill scanning fallbacks so local Skill discovery is directory-only (`<slug>/SKILL.md`); wrapper bumped to `2026.03.02-01`.
- Docs/contracts: updated README, usage/API docs, and wrapper interface docs to reflect `~/.agents/skills` storage and clarify that `/skills/store` persists canonical `SKILL.md` markdown content.
- Tests: expanded wrapper Skill-format assertions to lock `.agents/skills` usage and reject the legacy `.codex/skills` path.

# 2026-02-28
- cdx wrapper: post-run auth push change detection now compares both `last_refresh` and `auth.json` SHA-256 content, so same-timestamp auth/token updates still upload (including concurrent-guard runs) and fleet hosts do not get stranded on stale auth; wrapper bumped to `2026.02.28-02`.
- cdx wrapper: spark summary safeguard now also applies when users explicitly pass `--model gpt-5.3-codex-spark` (not only lane/host model injection), preventing OpenAI 400 `unsupported_parameter` errors for `reasoning.summary`; wrapper bumped to `2026.02.28-01`.
- Docs/tests: updated wrapper reasoning-summary coverage and `interface-cdx` model-summary behavior notes for explicit spark model selection.

# 2026-02-27
- Codex 0.105/0.106 compatibility: config normalization now maps legacy `features.web_search_cached` to root `web_search="cached"` and continues mapping `features.web_search_request` to `web_search="live"`.
- Config builder/runtime cleanup: obsolete feature keys (`steer`, `experimental_windows_sandbox`, `enable_experimental_windows_sandbox`) are now ingest-compatible but removed from normalized/rendered config output.
- Admin config UI: removed obsolete Steer and Windows sandbox switches, added `voice_transcription` feature toggle, and cache-bumped `config.js` to `v=2026-02-27-01`.
- cdx wrapper: when lane/host model injection selects `gpt-5.3-codex-spark`, wrapper now also injects `--config model_reasoning_summary=none` to match current Codex CLI/API behavior; wrapper bumped to `2026.02.27-01`.
- Tests/docs: updated config/wrapper coverage for spark summary handling + obsolete key dropping and refreshed config/wrapper/overview interface docs to match current behavior.

# 2026-02-23
- Security/network trust: added explicit forwarded-header trust gating via `TRUST_X_FORWARDED` + `TRUSTED_PROXY_CIDRS`; client IP and base-url/origin resolution now honors `X-Forwarded-*` only from trusted proxy source IPs.
- Security/host routing: added production-facing `PUBLIC_BASE_URL` policy controls (`PUBLIC_BASE_URL_REQUIRED`, `STRICT_HOST_VALIDATION`) and tightened MCP origin behavior with opt-in request-host auto-allow (`MCP_ALLOW_REQUEST_HOST_ORIGIN`).
- Runner hardening: added optional API->runner shared-secret authentication (`AUTH_RUNNER_SHARED_SECRET` / `RUNNER_SHARED_SECRET`) and hardened auth debug dumps so they require dual opt-in and are disabled in production.
- Crypto/key management: added staged key-rotation support for auth secretbox encryption (`AUTH_ENCRYPTION_KEYS`, `AUTH_ENCRYPTION_ACTIVE_KID`) with backward-compatible decrypt support for legacy ciphertext format.
- Startup/runtime behavior: added `scripts/migrate.php` and boot flags (`RUN_MIGRATIONS_ON_BOOT`, `RUN_BACKFILLS_ON_BOOT`) so schema/backfill work can be moved out of request-path in production.
- Container/deploy hardening: switched compose project naming to `codex-orchestrator`, reduced runtime image packages/extensions, and added compose hardening defaults (`read_only`, `tmpfs`, `cap_drop: [ALL]`, `no-new-privileges`) for API/runner sidecars.
- Admin/UI/docs polish: unified visible product naming on admin pages, self-hosted login fonts (no Google Fonts dependency), refreshed security/install/MCP/runner/interface docs, and expanded regression coverage for trusted-proxy IP resolution, runner shared-secret checks, and encryption key rotation.

# 2026-02-22
- Admin websocket hardening: dashboard live-refresh routing now uses explicit action/domain constants with a codified unknown-action fallback (`overview` + `hosts`), websocket client parsing now validates event envelopes and seeds reconnect cursors from `/admin/ws/info` `last_event_id`, admin dashboard HTML cache-bumped updated `dashboard.js`/`admin-ws.js` assets, and new regression tests now lock script wiring/order plus websocket client/route metadata contracts.
- Startup sync/API: added `POST /sync/status` and `POST /sync/bootstrap` plus `StartupSyncService` to batch startup pull diffs/payloads for prompts, Skills, AGENTS.md, and config; wrapper now attempts bundled startup pull first and falls back to legacy per-resource sync on older servers; added contract schemas/fixtures/tests for both endpoints; wrapper bumped to `2026.02.22-03`.
- cdx/CI: split wrapper monolith fragments (`bin/cdx.d/02-auth.sh`, `bin/cdx.d/05-main.sh`) into ordered concern-focused parts, added a built-wrapper ShellCheck gate (`shellcheck -S warning -e SC2034 bin/cdx`), and added `scripts/verify-wrapper-version-bump.sh` to require `WRAPPER_VERSION` bumps when `bin/cdx` changes; wrapper bumped to `2026.02.22-02`.
- API/docs/testing: added executable interface contracts for critical host responses (`docs/contracts/auth-retrieve.schema.json`, `auth-store.schema.json`, `versions.schema.json`, `usage-ingest.schema.json`) with fixture validation (`tests/ContractSchemasTest.php`), live `AuthService` contract coverage (`tests/AuthServiceContractResponsesTest.php`), auth deny reason contract checks (`tests/AuthReasonContractsTest.php`), and a docs drift gate (`scripts/verify-interface-contracts.php`) wired into CI.
- Installer: `curl .../install/<token> | bash` now ends with a compact post-install quickstart block (`cdx --version`, first `cdx` sync/auth run, and `cdx --execute` example) so hosts get immediate usage guidance at install completion.
- Host registration: insecure `POST /admin/hosts/register` now accepts optional `duration_minutes` (0–480) so newly created/rotated insecure hosts can immediately use the configured allow-window duration instead of always starting from the fixed 30-minute default; admin New Host now sends the current Insecure Host Window slider value and cache-bumps the dashboard asset version.
- cdx: run-lock scope now appends the caller UID (`<installation-or-api-scope>-u<uid>`) so stale root-owned files in `/tmp` do not disable concurrent-guard locking for non-root users on shared hosts; wrapper bumped to `2026.02.22-01`.

# 2026-02-21
- cdx: concurrent-guard runs now still push changed `auth.json` at exit and still report token usage to `/usage`; guard messaging now clarifies only pre-run sync/update mutations are skipped. Wrapper bumped to `2026.02.21-03`.
- Admin config builder: added a `Multi-agents` feature toggle and defaulted `[features].multi_agent = true` in rendered/normalized `config.toml`; cache-bumped `config.js` asset version.
- cdx/config: reserved Codex top-level subcommands from profile shorthand so `cdx cloud|features|...` always passes through to Codex (explicit `--profile <name>` still works for colliding profile names); wrapper bumped to `2026.02.21-02`.
- Config builder: removed deprecated `approval_policy=on-failure` from admin UI and added server-side normalization that auto-migrates stored/rendered root/profile approval policy values from `on-failure` to `on-request`.
- cdx: fixed wrapper self-update restart on macOS/legacy Linux by guarding empty original argv under `set -u` (preserves original args when present, falls back to no-arg re-exec when empty, and hardens lock metadata argv formatting); wrapper bumped to `2026.02.21-01`.

# 2026-02-20
- cdx: fixed run-footer column alignment by keeping the `Run cost` label ASCII-only and moving the Unicode `💰` marker into the cost value text; wrapper bumped to `2026.02.20-02`.
- Admin hosts/logs/settings: left-rail menus now use a nav-height-aware sticky top offset so they remain below the main header bar while scrolling.
- cdx: run-footer cost display now formats `/usage` `data.cost` as two decimals with a trailing dollar sign (for example `0.43$`) on the `Run cost` line; wrapper bumped to `2026.02.20-01`.

# 2026-02-19
- Admin hosts/logs: removed the same outer left/right content gutter as Settings so left rails sit flush to the viewport edge on both pages.
- Admin logs: replaced the old top `API/MCP/Events` selector with a left-rail view selector (matching the new hosts/settings rail pattern) and kept mobile on a sticky segmented selector.
- Admin hosts: replaced the old top `All/Secure/Insecure/Unprovisioned` selector with a left-rail filter box (matching settings rail styling) and kept mobile on a sticky segmented selector.
- Admin settings: normalized settings-panel spacing by removing per-panel top margin inside the settings content column, aligning the main table/panel start line with the left rail.
- Admin settings: aligned the left rail vertical start with page content by restoring a settings-specific sidebar top offset (`top: 16px`) while keeping the outer left gutter removed.
- Admin settings: removed the remaining outer gutter in the Settings view so the left rail aligns to the browser edge (settings-only override for `.app`/`.content` spacing).
- Admin settings: tightened left-rail spacing so the settings nav sits flush at the rail's top-left edge (removed sticky top offset, list gaps, and pill-style item insets).
- Admin settings: flattened the left sidebar menu to a single level (removed the `Advanced` subsection) and removed extra top/left inset spacing so nav items align flush with the rail.
- Admin settings: replaced the flat settings tab row with a cleaner IA (desktop left rail + mobile sticky segmented scroller), while preserving existing `#settings/<tab>` hash routes and panel behavior.
- Admin dashboard: removed the hero copy block (`2026 Mission Control` / `Fleet At A Glance`) from the top dashboard info box.
- Admin hosts: re-added the `🍪` marker in the `Authorized Hosts` list for the host that last submitted the current canonical `auth.json` (`auth_source=true`), restoring quick visual attribution.
- Admin dashboard: replaced the top menu bar with a scoped 2026 navigation layer (`data-nav-version="2026"`) featuring a cleaner desktop command bar, explicit `Overview` entry, and a mobile hamburger off-canvas drawer/backdrop flow while preserving existing nav IDs/actions (`New host`, theme toggle, logout) and hash-based panel routing.
- Admin websocket live updates: expanded push-driven refresh coverage across the full admin SPA (Overview, Hosts/Host Detail, Settings panels, Users, Config Builder, Profiles) using action-targeted `log.created` routing with debounced in-flight guards; dashboard now refreshes host-backed stats with live `/admin/hosts` data, config/profile editors hold unsaved local edits and show a remote-update notice, and settings mutations now emit explicit log actions (`admin.api.state`, `admin.cdx_silent`, `admin.reverse_dns`, `admin.insecure_approval`, `admin.codex_version`, `admin.quota_mode`, `admin.prune_policy`) so connected clients stay in sync via server push.
- Admin dashboard graphs: replaced uPlot modal-first charts with inline Chart.js panels on the main dashboard (quota + cost) including range presets (7/30/60/90/180), zoom/pan, previous-period compare overlays, line/stacked mode toggle, pinned keyboard selection, legend visibility persistence, CSV export, and backend queryable history endpoints (`from`/`until`, interval/group/lane/window filters).
- Auth API: `/auth` `command:"store"` submissions are now always evaluated as candidate auth payloads even when insecure-host windows are closed; retrieve/window gating behavior remains unchanged and store still enforces normal API-key/IP/reverse-DNS/installation plus runner validation checks.
- Admin dashboard: rebuilt the Overview layout for a calmer compact flow (mission strip first, ordered card matrix), consolidated conflicting dashboard CSS layers into one canonical rule set, and normalized equal-height card behavior across ChatGPT usage, KPI cards, and Ops Radar in both light/dark themes with tuned mobile stacking.
- cdx: redesigned end-of-run output into a compact footer (`Run usage`, `Run cost`, `Sync`), removed noisy raw `Usage push | ...` / `Auth push | ...` lines, and added a dedicated `💰` run-cost line populated from `/usage` `data.cost` (ASCII fallback label when Unicode is unavailable); wrapper bumped to `2026.02.19-01`.
- Admin hosts: fully redesigned the `Authorized Hosts` list for lower visual noise; rows now focus on hostname, status, last seen, Codex version, and a single insecure-window toggle (removed IP/added/auth-meta/wrapper clutter from list rows; details remain on host pages).
- Admin hosts: replaced the host detail modal with dedicated host detail pages at `/admin/hosts/{id}` and reorganized the content into visual sections (`Action Items`, `Features`, `Stats`, `Infos`) with deep-linkable URLs.
- Admin routing: added HTML dispatch for `GET /admin/hosts/{id}` through `public/admin/index.php` so direct host detail links resolve without falling through API routes.
- Docs/tests: updated host-detail interface references (`docs/OVERVIEW.md`, `docs/interface-api.md`, `docs/interface-cdx.md`) and added UI routing coverage for the dedicated host detail page shell.

# 2026-02-18
- Skills: added "Checkmk Deploy Verify" skill manifest with `#checkmk` trigger plus mandatory pre/post Checkmk agent verification and Dockerized git-copy workflow guidance.

# 2026-02-16
- cdx: auth summary now reflects successful `store` uploads as `valid` (instead of lingering `upload_required` from the pre-store retrieve result), so healthy hosts no longer look stuck in upload-required state; wrapper bumped to `2026.02.16-12`.
- cdx: Quota `Active lane` now marks Spark with a fastness hint (`spark ⚡` on UTF-8 terminals, `spark (fast)` fallback on non-Unicode terminals).
- cdx: removed the `| <n> day partition` suffix from the Daily allowance note in Quota output; it now shows only `allowance <n>%/day` to reduce line noise.
- cdx: summary packing defaults tuned for readability: Quota now prints one bar/metric per line (`SUMMARY_ITEMS_PER_ROW_QUOTA=1`), while Versions defaults to two entries per row (`SUMMARY_ITEMS_PER_ROW_VERSIONS=2`) to avoid overlong lines (e.g., keeps `AGENTS.md` with `config.toml`).
- cdx: add first-class lane steering via `cdx lane` (`normal|spark`, optional `--persist`, and `clear --persist`), plus host lane persistence endpoints (`GET/POST /host/lane`) and host-level `lane_preference`; wrapper now maps host/command-selected lanes to profile-first (`[profiles.normal|spark]`) with model fallbacks, and wrapper version bumped to `2026.02.16-11`.
- cdx: summary blocks now render aligned padded columns instead of raw tab joins, and Quota defaults to one metric per row (`SUMMARY_ITEMS_PER_ROW_QUOTA=1`) so quota bars line up cleanly across lines; wrapper bumped to `2026.02.16-10`.
- cdx: fixed summary rendering exit-on-start regression caused by tabbed row packing (`set -e` with `(( packed_count++ ))`), aligned quota graph labels, and added non-active lane (Spark/Normal) 5h + weekly bar rows in the Quota block; wrapper bumped to `2026.02.16-09`.
- cdx: compact summary blocks now pack up to three tab-separated entries per line across Health/Versions/Usage/Quota/Result sections (override with `CODEX_SUMMARY_ITEMS_PER_ROW`); wrapper bumped to `2026.02.16-08`.
- cdx: add Linux `yum` fallback support for RHEL-family prerequisite installs (including legacy CentOS 7/8/9 paths), map `script` to `util-linux` for `dnf`/`yum`, and add wrapper package-manager coverage tests; wrapper bumped to `2026.02.16-07`.
- cdx: redesigned the boot summary into human-readable `Health`/`Versions`/`Usage`/`Quota`/`Result` sections, improved quota bar presentation with Unicode+ASCII fallback, condensed non-active quota lane output into an `Other lane` line, and switched insecure clean-sync result text to `Synced on insecure host; auth refreshed.`; wrapper bumped to `2026.02.16-06`.
- Quotas: capture and normalize both ChatGPT quota lanes from `/wham/usage` (normal top-level `rate_limit` plus Spark from `additional_rate_limits`), persist Spark lane columns in `chatgpt_usage_snapshots`, and expose lane-aware payloads (`normal_window`, `spark_window`, `active_quota_lane`) while keeping legacy `primary_window`/`secondary_window` compatibility.
- cdx: quota enforcement is now active-lane aware (`normal` vs `spark`), summaries include lane context + other-lane snapshot, and wrapper auth sync now parses dual-lane quota payloads; wrapper bumped to `2026.02.16-02`.
- cdx: split alternate-lane quota summaries out of `Usage` into dedicated rows (`Quota (Spark@s)` / `Quota (Normal@s)`), so call/token usage stays isolated; wrapper bumped to `2026.02.16-04`.
- cdx: table-summary label width now auto-sizes per render so the `|` separators stay aligned across `Core`, `Usage`, and quota rows; wrapper bumped to `2026.02.16-05`.
- Admin dashboard: ChatGPT usage card and quota history now render both normal and Spark lanes (including Spark history points when available).
- Admin dashboard: restored the legacy two-card quota layout (`5-hour` + `weekly`) and now stacks Spark bars under normal bars inside each card.
- Admin auth UX: replaced dashboard login overlay with a dedicated `/admin/login` page (bright glass UI), added server-side redirects between `/admin/` and `/admin/login` based on session state, and removed password-reset UI/API paths (`/admin/auth/password/request|reset` now return `410 Gone`).
- Admin routing: fixed direct hits to `/admin/login` and `/admin/` that reached `public/index.php` by dispatching both routes through `public/admin/index.php`, preventing `Route not found`.
- Admin config/profiles/host overrides: add `gpt-5.3-codex-spark` with reasoning levels `low|medium|high|xhigh` (UI label: `xhigh (Extra high)`).
- Config/API: enforce strict model allowlist for fleet model fields and `/admin/hosts/{id}/model` overrides (`gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5.2`, `gpt-5.1-codex-mini`); dead models are no longer accepted.
- cdx: `--execute` now launches with `--model gpt-5.3-codex` (removed dead `gpt-5.1` default for that path); wrapper bumped to `2026.02.16-01`.
- Ops: manually verified `codex --help` against local Codex `v0.101.0` and confirmed wrapper-injected flags still match the current CLI surface (no runtime flag audit added).

# 2026-02-14
- Config: managed `[mcp_servers.cdx]` entry now includes `startup_timeout_sec = 30` to reduce Codex MCP startup timeouts when the coordinator is slow to respond.
- API: reduce per-request overhead by running schema migrations once per deployed schema hash (sentinel under `storage/wrapper/`), gating legacy encryption/backfill routines behind `versions` flags, avoiding `daily_preflight` DB writes on requests where no preflight work was performed, and skipping runner preflight on `/versions` and `/mcp` (improves `/versions` healthcheck latency and host startup when runner is red).
- Runner: bump the auth-runner bundled Codex CLI to `rust-v0.101.0` and always run probes in a per-request temp `$HOME` (cleaned up after each run) to fix `mcp startup: no servers` probe failures and avoid persisting `~/.codex/auth.json` inside the runner container.

# 2026-02-13
- cdx: Linux prerequisite auto-install now checks/installs `script` (util-linux) alongside `curl`/`unzip` when wrapper-managed dependency installation is allowed, so PTY capture support is provisioned automatically; wrapper bumped to `2026.02.13-18`.
- cdx: concurrent-guard runs now do a read-only `/auth` retrieve (no auth store/local auth write) to keep Quota 5h/week/day lines fresh instead of showing `n/a` from stale local-only state; wrapper bumped to `2026.02.13-17`.
- cdx: when concurrent guard is active, boot summary output is now compacted to a single concurrent-guard line plus quota lines (suppresses Core/Versions/Result noise for that path); wrapper bumped to `2026.02.13-16`.
- Admin dashboard: removed forced desktop horizontal scrolling for table wrappers and tuned Fleet Skill registry column sizing (narrower Description cap + fixed Actions width) so per-skill `Edit`/`Delete` stay visible without horizontal scroll.
- Admin dashboard: hardened Skills/Prompts action-column visibility by making table wrappers horizontally scrollable at all desktop widths and rendering row actions inside a dedicated `.table-actions` container; cache-bumped dashboard CSS/mobile CSS/JS.
- cdx: non-TTY stdout launches no longer rewrite argv by forcing `exec`; wrapper now preserves user subcommands/args verbatim and fails fast with a hint to use `cdx --execute` when interactive no-arg launch is attempted without a TTY; wrapper bumped to `2026.02.13-15`.
- Admin dashboard: fixed Fleet Skill registry action visibility by styling shared `table-wrapper` containers like `table-wrap` (restoring horizontal overflow/layout on narrower screens) and labeling the final Skills column as `Actions` so Edit/Delete controls are discoverable.
- Admin dashboard: Mission Control year label now renders from the live calendar year, removed the embedded Fleet At A Glance subtitle + inline refresh/new-host buttons, and moved the Fleet At A Glance card below the primary dashboard grid.
- cdx: add a host-wide active-run guard to prevent concurrent wrapper mutation storms; secondary runs now skip auth/sync/update writes (and insecure-host auth purge), launch Codex with valid local auth, and support explicit override via `--allow-concurrent-sync`; wrapper bumped to `2026.02.13-14`.
- Admin dashboard: Fleet Skill registry now has a strict edit mode (existing entries open as `Edit skill`, slug is locked during edits to avoid accidental clone-via-rename, save action is labeled `Save changes`, and status feedback distinguishes no-op saves) plus explicit delete actions (`Delete` in table rows and a modal `Delete` button while editing).
- cdx: harden `--uninstall` for multi-user hosts; when additional registered host users exist and the wrapper cannot escalate (`root`/passwordless `sudo -n`), uninstall now fails fast instead of attempting partial cleanup; wrapper bumped to `2026.02.13-13`.
- cdx: honor `NO_COLOR` by disabling ANSI colors even on TTY output, and auto-enable a compact minimal output mode when `TERM=dumb` (suppresses MOTD and prints concise Core/Result summary); wrapper bumped to `2026.02.13-12`.
- cdx: expand Linux prerequisite auto-install package-manager detection to include `pacman`, `zypper`, and `apk` (in addition to `apt-get`/`dnf`), including package-name translation for `python3` on Arch-family hosts; wrapper bumped to `2026.02.13-11`.
- Admin dashboard: removed the Mission Pulse “Action needed” card, moved ChatGPT Account to the top of the dashboard flow ahead of the four KPI cards, and reformatted Ops Radar into a 3x2 desktop grid (with responsive collapse on smaller screens).
- cdx: add wrapper-only `cdx status` and `cdx doctor` commands (no Codex launch) with summary-only and extended diagnostics modes, plus actionable doctor hints and API `/versions` reachability probe; wrapper bumped to `2026.02.13-10`.
- cdx: add a shared embedded Python HTTP utility (`CODEX_PY_HTTP_UTIL`) and refactor auth/prompt/skill/AGENTS/config/usage sync snippets to reuse one force-IPv4 + TLS-context + JSON-request implementation, reducing duplicated network code and drift; wrapper bumped to `2026.02.13-09`.
- cdx: npm-based Codex updates now honor privilege context (`root` direct install, `sudo -n` when available, otherwise user install), aligning update behavior with uninstall handling on root-owned global npm prefixes; wrapper bumped to `2026.02.13-08`.
- cdx: portability hardening for mixed Linux/macOS hosts: replaced GNU-only `sort -V` comparisons with Python-backed version compare, switched ANSI stripping to runtime-detected `sed -r`/`-E`, and replaced direct `sha256sum` calls with a portable hash helper (`sha256sum`/`shasum -a 256`/`openssl`/`python3` fallback); wrapper bumped to `2026.02.13-07`.
- cdx: make local sync writes atomic for `auth.json`, `AGENTS.md`, `config.toml`, and prompt/skill baseline files (`.prompt-baseline.json`, `.skill-baseline.json`) using temp file + `fsync` + replace; wrapper bumped to `2026.02.13-06`.
- cdx: tighten PTY fallback retry guard so direct rerun only happens when the PTY launch failed *and* output matches known TTY-incompatible patterns; avoids accidental second runs on successful commands; wrapper bumped to `2026.02.13-05`.
- cdx: fix non-TTY command dispatch so explicit Codex subcommands are no longer rewritten as `exec ...` (prevents cases like `cdx exec ... | cat` becoming `codex exec exec ...`); wrapper bumped to `2026.02.13-04`.
- cdx: preserve interactive TTY behavior when PTY capture is disabled/fails (avoid `tee` pipe fallback that can trigger `stdout is not a terminal`), and auto-disable PTY capture on hosts where Codex reports TTY-incompatible PTY output (`~/.codex/.cdx_no_pty`, override with `CODEX_FORCE_PTY=1`).
- Admin dashboard: full 2026 visual overhaul for Overview (mission control hero, pulse score, ops radar, richer fleet/cost/runtime cards, and updated mobile layout).
- Admin new host modal: the “Run on the target host” copy button now shows inline feedback (`Copying…`, `Copied`, `Copy failed`).

# 2026-02-12
- Admin config: add `model_provider` and `local_provider` controls to the config.toml builder to match the current Codex CLI flags.
- cdx: refresh bootup summary styling (modern header + divider + wrapped rows) while keeping existing status content.

# 2026-02-11
- Config: add notice model migration defaults to map `gpt-5.2-codex` to `gpt-5.3-codex`.
- Config: add `[security] dangerously_bypass_approvals_and_sandbox` toggle (wired into `cdx` to add `--dangerously-bypass-approvals-and-sandbox` when enabled).

# 2026-02-09
- Fixed admin "Enable window" actions for insecure hosts (host enable/disable + approval approve/deny/allow-domain) returning HTTP 409 due to incorrect route parameter handling.

# 2026-02-06
- Admin config: default model switched to `gpt-5.3-codex` and model pickers now include `gpt-5.3`/`gpt-5.3-codex`.

# 2026-02-08
- Security: remove un-gated `public/admin/mtls-debug.php` endpoint that echoed request headers.
- Security: constrain outbound cURL redirects to HTTPS in pricing + ChatGPT usage fetchers.
- Maintenance: remove unused `src/Http/Router.php` (router isn’t used outside `public/index.php`).
- Admin UI: start visual refresh (new theme tokens for light/dark/auto, header polish, and a sectioned Config layout with search).
- Admin dashboard: add a Fleet Health header with quick actions (refresh, new host).
- Admin hosts: improve table scanability with clearer badges and grouped KPI rows.
- Admin hosts: host detail modal now highlights “Problems” at the top when something needs attention.

# 2026-02-02
- cdx: pick `script` flags per platform and only run PTY capture when stdin/stdout are TTYs (fixes macOS `script` errors).
- cdx: avoid `script -c` on macOS and guard wrapper restart args to prevent unbound variable crashes.
- cdx: avoid unbound `SCRIPT_SUPPORTS_C` by keeping script detection out of subshells.

# 2026-02-01
- cdx: macOS compatibility for installer + wrapper (apple-darwin assets, Homebrew auto-install for missing python3/curl/unzip, bash 3.2-safe wrapper).

# 2026-01-31
- Admin auth: rehash admin passwords on successful login when hashing params change.
- Admin auth: reject password-reset emails with suspicious header injection input.
- Admin dashboard: remove unused WebAuthn helper code paths.
- Admin config: replace `web_search_request` with `web_search` (live/cached/disabled), while keeping legacy mapping for existing configs.
- Admin config: render `web_search` at the top level (string enum) instead of under `[features]` to match current Codex config schema.

# 2026-01-30
- cdx: add `-4` flag to force IPv4 for all wrapper network calls (sync, usage, update/download).

# 2026-01-28
- Admin config: render `steer = true|false` under `[features]` in fleet config.toml.
- Config: bake a trusted-project stanza into per-host config.toml using the caller's username/home to suppress Codex trust warnings.

# 2026-01-26
- cdx: honor `force_ipv4` for Python-based sync/usage HTTPS calls so IPv4-only hosts don't stall on IPv6.
- Insecure hosts: allow long-running sessions to upload refreshed auth after the window closes (bounded by `INSECURE_SESSION_MAX_MINUTES`).
- Admin hosts: add a 🍪 badge for the host that last submitted the current auth.json.
- Admin config: add steer conversation toggle (default on) to render `steer = true` in fleet config.toml.
- Admin config: move the Steer conversation toggle into the Security & Features card.
- Admin dashboard: move the Estimated total trend control into a 📊 icon beside the currency label.
- Admin hosts: move the status pill into a Status column and swap the insecure toggle to an iPhone switch.
- Admin hosts: stop showing "Pruning soon" when host pruning is set to never.
- Admin hosts: show insecure enabled hosts as Can login/Outdated instead of Locked.
- Insecure domain auto-allow rules now auto-revoke once their window expires.
- Admin memories: add delete button alongside each memory row.
- Admin memories: reveal delete buttons on row hover or focus.

# 2026-01-25
- Admin hosts: allow per-host AGENTS.md version pinning in the host modal (default follows fleet setting).
- API: add per-host AGENTS.md override field and endpoint for host-specific pins.
- Admin agents: prompt for a replacement version when deleting AGENTS.md versions that are pinned by hosts.
- Admin agents: show how many hosts are pinned to each AGENTS.md version.
- Admin agents: replace “pin” wording with “default” in AGENTS.md editor copy.
- Admin host modal: swap Reverse DNS to an iPhone-style toggle and place it beside the Codex CLI version picker.
- Docs: emphasize admin login in install/usage guides and treat mTLS as an advanced topic.
- Admin hosts: hide the “Locked” health pill in the host table.
- Admin hosts: collapse host-table status chips to a single pill.
- Admin dashboard: center the summary cards and shorten the wrapper check timestamp text.
- Admin hosts: color the Outdated pill green when auth is current and orange when auth is stale.
- Admin hosts: fix host-tab active state contrast in dark mode.

# 2026-01-19
- Skills: added "Git Commit" skill manifest to the fleet registry.
- Skills: added "Checkmk Local Checks" skill manifest to the fleet registry.
- AGENTS.md: added versioned storage with pinned vs latest serving, plus delete controls in the admin editor and new admin endpoints.

# 2026-02-10
- Skills: added "SSH Login" skill manifest to the fleet registry.
- Admin new host modal: "Run on the target host" command box now follows theme toggle (light/dark/auto); cache-bumped dashboard.css.
- Admin UI: normalized settings, usage charts, and mobile cards to theme tokens so light/dark/auto stays consistent; cache-bumped dashboard.css/dashboard-mobile.css.

# 2026-01-18
- Admin dashboard: toast notifications now honor light/dark/auto theme colors; cache-bumped dashboard.css.
- Admin dashboard: 2026 polish pass (bullet meters + theme toggle w/ auto light/dark tokens + softer usage window sections + restored overpay note); cache-bumped dashboard.css/dashboard-mobile.css/dashboard.js.
- Admin dashboard: 2026 visual pass (calmer background, no outer mega-card, split Hosts/Version, consistent focus ring + typography); cache-bumped dashboard.css/dashboard-mobile.css/dashboard.js.
- Admin UI: switched admin pages to a ChatGPT-style dark theme.
- Admin dashboard: restyled the Estimated Total cost card for a cleaner plan/utilization layout.
- Admin dashboard: combined Hosts, Version, and Validation Service into one summary card.
- Admin header: show "Christian Reiss 🔐" in the header and make the lock icon the logout action.
- Admin settings: moved mTLS status to Settings → General and removed the header pill.
- Admin logs: fixed `#logs` deep link so only logs render (dashboard panel now stays hidden).
- Admin dashboard: merged input/output/cached tokens into a single summary box and removed the redundant total tokens card.
- Admin header: removed the Dashboard nav item; the Codex Coordinator logo now routes to the dashboard.
- Admin dashboard: unified visual overhaul (palette, typography balance, reimagined command bar, refreshed main dashboard layout, cards, tables, and modals); cache-bumped dashboard.css/dashboard-mobile.css.
- Admin header: display the logged-in user name next to mTLS status; cache-bumped admin-auth.js and dashboard.css.
- Admin users: show relative last login timestamps below the absolute date in the Users table; cache-bumped users.js and dashboard.css.
- Admin users/login: require password confirmation in reset and user password flows; cache-bumped admin-auth.js and users.js.
- Admin users: remove the add/edit user modal close button (use Cancel or backdrop instead).
- Admin users: hide the "Wipe users" button until at least one user exists.
- Admin users: switch the Active toggle in the user modal to the iPhone-style switch.
- Admin login: show password recovery panel under the login modal (no longer hidden behind the overlay); cache-bumped admin-auth.js and dashboard.css.
- Admin: add admin login, user management, roles, and password recovery (userless bootstrap when no admins exist).
- Admin: insecure approval modal now uses the current insecure window duration when enabling hosts.
- Admin dashboard: insecure hosts modal live-updates via websocket events and refreshes countdowns while open.
- Installer: stop auto-running `cdx` after curl | bash; users run it manually when ready.
- Admin UI: refined the dark palette to better match ChatGPT's dark theme (neutral backgrounds, subdued surfaces).
- Admin UI: reverted palette to the original colors while keeping the new layout.
- Admin dashboard: removed the "over/under plan" copy so Estimated Total is a straight plan comparison.
- Admin header: moved the logged-in name to the far-right slot in the menu bar.
- Admin dashboard: centered the Estimated Total amount in the cost card.
- Admin dashboard: shortened the Validation line in the summary card to a compact status/timestamp.

# 2026-01-15
- Admin dashboard: fallback to SVG rendering when uPlot fails so history charts still load.
- cdx wrapper: surface reverse DNS denial reason in auth sync output; wrapper bumped to 2026.01.15-01.
- Auth: add reverse DNS enforcement for `/auth` (global setting with per-host overrides); requests now require forward A/AAAA + PTR match when enabled.
- Admin dashboard: add Reverse DNS Enforcement toggle + per-host override selector; cache-bumped dashboard.js v=2026-01-15-01.
- Installer: Unknown / not found in code (current installer prints manual next-step `cdx` commands and does not auto-run `cdx`; superseded by 2026-01-18 installer behavior).
- Auth: add trailing insecure-host grace window for final auth/usage pushes after the window expires (configurable via `INSECURE_GRACE_MINUTES`, default 60); explicit disable clears grace.
- Admin dashboard: refine uPlot usage + cost charts with consistent tick splits and hide the default legend; cache-bumped dashboard.js v=2026-01-15-03 and dashboard-mobile.css v=2026-01-15-01.
- Hosts: rename stored IP columns to `ip4`/`ip6` (auto-migrated from legacy `ip`/`ip_alt`), and surface the new fields in admin API/UI.

# 2026-01-14
- Auth: allow secure dual-stack hosts to bind one IPv4 + one IPv6 without enabling roaming; admin UI now shows the secondary IP when present.
- Admin insecure approvals: allow domain auto-allow rules (modal action + toggler revoke) so matching subdomains can auto-open insecure windows.
- Admin dashboard: remove the ChatGPT Account refresh button (websocket/live refresh remains).
- Admin insecure approvals: clicking outside the approval modal or pressing Esc now cancels the request to avoid stuck pending approvals.

# 2026-01-13
- Admin dashboard: remove per-host Codex version row from the host detail modal (fleet always uses the latest wrapper).
- Admin dashboard: ChatGPT 5‑hour/weekly reset timers now tick locally between refreshes, keeping “Resets in …” and time meters live.
- Insecure hosts: optional admin approval gate (Settings → General) that prompts via websocket, exposes approve/deny endpoints, and lets cdx wait/poll for approval when the window is closed.
- cdx wrapper: wait/poll for insecure host approvals when enabled; wrapper bumped to 2026.01.13-02.
- Admin dashboard: filter “CDX refused” toasts to known hosts/fqdns to avoid noise from unknown keys.
- Admin dashboard: emit “CDX refused” toasts for denied `/auth` requests tied to known hosts (disabled host, IP mismatch, installation mismatch, insecure window closed).
- Admin dashboard: “CDX authorized” toasts now include relative time in the message.
- Admin dashboard: emit “CDX authorized” toasts on successful `/auth` retrieve (websocket test hook).
- Admin dashboard: add websocket-driven toast framework (auto-dismiss + manual close), new `/admin/toasts` endpoint, cache-bumped dashboard.js v=2026-01-13-03 and dashboard.css updated.
- Admin dashboard: Overview info cards live-update via websocket events (hosts, versions, tokens, cost, runner, ChatGPT); cache-bumped dashboard.js v=2026-01-13-02.
- Admin dashboard: ChatGPT 5-hour/weekly usage boxes live-update via websocket events; cache-bumped dashboard.js v=2026-01-13-01.
- Admin: add optional websocket event stream for live dashboard updates (`admin_events` table, `/admin/ws/info` bootstrap, `scripts/admin-ws.php`, admin-ws.js hook).
- Admin dashboard: remove hover lift on header nav buttons (menu bar, Toggler, New host); cache-bumped dashboard.css v=2026-01-13-03.
- Admin dashboard: remove button glow across all hover states; cache-bumped dashboard.css v=2026-01-13-02.
- cdx wrapper: disable prompt-toolkit cursor position reports under PTY capture unless the env is already set, avoiding interactive cursor errors on some terminals; wrapper bumped to 2026.01.13-01.
- cdx wrapper: compress the Result line on clean insecure-host runs to reduce repeated noise; wrapper bumped to 2026.01.13-03.
- Ops: add docker-compose `admin-ws` service and document enabling `ADMIN_WS_ENABLED` for live admin toasts/websocket updates.

# 2026-01-12
- cdx wrapper: enforce baked FQDN at runtime (override with `CODEX_ALLOW_FQDN_MISMATCH=1`), bumped wrapper to 2026.01.12-01.
- Admin hosts: add “Disable all” in Insecure hosts modal and hide bulk actions unless ≥2 active insecure hosts; cache-bumped dashboard.js v=2026-01-12-02.
- Admin hosts: fix the Insecure hosts “Extend all” button (binds reliably, shows how many hosts were extended) and cache-bump dashboard.js v=2026-01-12-01.
- Config builder: clamp verbosity to “medium” for gpt-5.1-codex-max (UI and server), avoiding unsupported text.verbosity values.
- Auth: insecure hosts now rebind their stored IP to the current client when the insecure window (or grace) is active, eliminating “IP bound” failures after toggling; logs emit `auth.insecure_ip_override`.

# 2026-01-08
- Admin dashboard: cost total stays neutral when API spend is below plan, and the overpay callout is shortened to "Overpaying by X%!"; cache-bumped dashboard.js v=2026-01-08-04.
- Admin dashboard: cost over‑plan callout uses neutral styling and explains the API-vs-plan mismatch; cache-bumped dashboard.js v=2026-01-08-03.
- Admin hosts: remove avg/last refresh subline from the Hosts header; cache-bumped dashboard.js v=2026-01-08-02.
- Admin auth: add a one-time seed command (curl | bash) that uploads local `~/.codex/auth.json` via `/seed/auth/{uuid}`; tokens expire after `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900s) and invalidate on first POST; new `auth_seed_tokens` table + admin UI wiring; cache-bumped dashboard.js v=2026-01-08-01.

# 2026-01-07
- Admin hosts: insecure window duration now supports a log-ish 0–8h (0–480 min) range for enable actions; API clamping updated; cache-bumped dashboard.js v=2026-01-07-01.

# 2025-12-25
- Admin config builder: added background terminal experimental feature toggle; cache-bumped config.js v=2025-12-25-03.
- Admin hosts: pruning indicator now honors Settings → General inactivity window (0 disables) instead of hard-coded 30 days; cache-bumped dashboard.js v=2025-12-25-02.
- Admin config builder: added switches for Codex 0.77 experimental feature flags (unified exec, RMCP OAuth, sandbox assessment, ghost commit, Windows sandbox); cache-bumped config.js v=2025-12-25-01.

# 2025-12-19
- Admin config builder/profiles/host overrides: add `gpt-5.2-codex` as a selectable model with low/medium/high/xhigh reasoning; server now forces reasoning summaries to `detailed` for that series just like other codex-specific models.
- cdx wrapper: detect Codex versions that lack `--reasoning-effort`, skip passing the flag, and emit a warning instead of failing the launch; wrapper bumped to 2025.12.19-01.

# 2025-12-18
- cdx wrapper: remove the duplicate insecure-host bootstrap warning and collapse the insecure-host result summary to "Codex to brrrr (insecure host)"; wrapper bumped to 2025.12.18-06.
- cdx wrapper: preserve argv across wrapper self-update restart so `cdx resume` (and other non-flag first args) survive the re-exec; wrapper bumped to 2025.12.18-05.
- Installer: choose the musl (static) Codex release asset on older glibc (<2.39) so CentOS 7 / Debian 11-class hosts don’t require `libssl.so.3`.
- Admin hosts/installer: “Allow insecure curl (-k)” now persists as a per-host `curl_insecure` flag and bakes `CODEX_SYNC_ALLOW_INSECURE=1` into the `cdx` wrapper (disables TLS verification for sync when you intentionally run self-signed); installer still bakes `CODEX_INSTALL_CURL_INSECURE=1` into the piped `bash` so wrapper + Codex downloads reuse `curl -k`; cache-bumped dashboard.js v=2025-12-18-02.
- Installer: use `cdx --wrapper-version` during install so it doesn’t run a full sync/codex launch (avoids surprising SSL failures during bootstrap).
- cdx wrapper: guard the Usage summary `token_bits` join so runs under `set -u` don’t crash with `token_bits[@]` unbound (affects hosts before the first token usage sync), fix baked-placeholder sentinels so per-host overrides (`model_override`, `reasoning_effort_override`, `force_ipv4`, `secure`, `installation_id`, `cdx_silent`) don’t get reset after baking, and allow wrapper self-update to pass `curl -k` when `CODEX_SYNC_ALLOW_INSECURE=1`; wrapper bumped to 2025.12.18-04.

# 2025-12-17
- Admin settings: Skill modal now shows validation/saving status inline, so slug/manifest errors are visible instead of hiding underneath the Fleet Skill registry panel.
- Admin settings: Fix the Fleet Skill registry “New” button so it always opens the modal and surfaces an error when the manifest input is missing instead of silently doing nothing.
- Admin settings: Fleet Skill registry now lives under Settings → Skills (tab after Profiles); the standalone `#skills` hash redirects to `#settings/skills`, and dashboard.js is cache-bumped to v=2025-12-17-04.
- Skill system: new `/skills` endpoints + `skills` table mirror slash-command behaviors (list/retrieve/store/delete) with `SkillService`, admin dashboard gets a Skills tab + modal editor, `cdx` syncs `~/.codex/skills` (pull + push) with offline-safe baselines, docs/README updated, and wrapper bumped to 2025.12.17-01.

# 2025-12-15
- Config builder: clamp `model_reasoning_summary` to `detailed` for `gpt-5.1-codex*` (OpenAI only accepts `reasoning.summary=detailed`); cache-bumped config.js v=2025-12-15-20.
- Admin hosts: added “Temporary host” provisioning (`POST /admin/hosts/register` body `temporary=true`) with a sliding 2-hour idle expiry (pruned 2h after the last successful host contact), backed by `hosts.expires_at` and `host.pruned` reason `expired`; cache-bumped dashboard.js v=2025-12-15-20.
- cdx wrapper: fixed token-usage parsing crashing on Python 3.9 (AlmaLinux 9) due to Python 3.10-only type hints (`str | None`); wrapper bumped to 2025.12.15-03.
- cdx wrapper: fixed `cdx --uninstall` failing (cmd_uninstall was invoked before the wrapper had defined its helpers); wrapper bumped to 2025.12.15-02.
- Installer: fixed insecure host registration emitting install tokens without an API key (which could 500 on `curl .../install/<token> | bash`).
- cdx wrapper: suppress duplicate boot summary/compat lines when the wrapper self-updates and re-execs (you now only get one header); wrapper bumped to 2025.12.15-01.

# 2025-12-14
- Admin settings/memories: wired the delete action to the numeric memory `record_id` (UI buttons now work, show host/key metadata, and disable when missing), documented the admin delete endpoint/field, and cache-bumped dashboard.js v=2025-12-14-13 + dashboard.css v=2025-12-14-11.
- Admin settings/memories: fixed the Memories tab not rendering (bad JS wiring + missing DOM ref). Loader now targets the Settings → Memories panel, wires `memoriesTableWrap`, and host filter passes `host_id`; cache bump to dashboard.js v=2025-12-14-12.
- Admin settings: fixed Settings → config.toml (and other settings tabs) sticking around when navigating back to the dashboard (HTML nesting bug: Settings panel-set was closed early).
- Admin settings/profiles: profile rows are now collapsed by default (click to expand) and the per-profile feature toggles render in a 2×2 grid; cache bump to dashboard.css/profiles.js v=2025-12-14-10.
- Admin dashboard: Validation Service card now shows the host that last wrote the current canonical auth.json (source FQDN + stored time); cache bump to dashboard.js v=2025-12-14-07.
- cdx wrapper: boot summary now shows MCP status, shortens Runner to icon-only, and moves the week-partition indicator from Core → Quota day; wrapper bumped to 2025.12.14-03.
- Admin settings/hosts: Codex Version selectors now omit GitHub prereleases (alpha/beta) and only list full releases, while still including the currently targeted/pinned/in-use version for visibility; cache bump to dashboard.js v=2025-12-14-04.
- Admin hosts: removed all row background coloring in the Authorized Hosts table (rows are now transparent; no secure/insecure/unprovisioned shading); cache bump to dashboard.css/dashboard-mobile.css v=2025-12-14-08.
- Profiles: added a Settings → Profiles tab to add/edit/delete `config.toml` profiles (model, reasoning effort, approval policy, sandbox mode, plus stream/search/image/network toggles). Config builder no longer embeds profile editing; per-profile TOML now includes nested `[profiles.<name>.features]` + `[profiles.<name>.sandbox_workspace_write]`. `cdx <profile>` is now shorthand for `--profile <profile>` when the profile exists; removed the old `cdx shell`/`cdx code` model presets; wrapper bumped to 2025.12.14-03; cache bump to dashboard.js/config.js/profiles.js v=2025-12-14-06.

# 2025-12-13
- Admin hosts: added per-host Codex CLI version override (“Global” or pinned semver) that overrides the fleet policy; pinned hosts get `client_version_source=locked` so `cdx` enforces the exact version; cache bump to dashboard.js v=2025-12-13-09.
- Admin settings: added a Codex version selector (Latest/recent releases) that can pin the fleet to a specific Codex release; when pinned (`client_version_source=locked`) the `cdx` wrapper enforces the exact target version (upgrade or downgrade); wrapper bumped to 2025.12.13-02; cache bump to dashboard.js v=2025-12-13-08.
- Config builder: fixed `config.toml` generator settings “disappearing” when `client_config_documents` had non-canonical/legacy rows (prefer `id=1` when present, tolerate double-encoded JSON settings).
- Admin hosts: when a host is flagged “Outdated auth”, the “Can login” chip is now suppressed (no more contradictory status); cache bump to dashboard.js v=2025-12-13-04.
- Admin access: fixed `requireAdminAccess()` enforcing `ADMIN_ACCESS_MODE=mtls` (removed stale `mtls_only` check) so `/admin/*` is denied when mTLS headers are missing.
- Admin hosts: hosts table row backgrounds now use a single neutral zebra stripe (removed status-based row gradients); cache bump to dashboard.js v=2025-12-13-03.
- Config sync: `/config/retrieve` now applies per-host `model_override` + `reasoning_effort_override` to the baked `config.toml` (`model`, `model_reasoning_effort`) so `~/.codex/config.toml` matches the host’s effective defaults.
- Admin hosts: model/reasoning overrides now auto-save on select (no Save button) and are baked into the per-host `cdx` wrapper download; wrapper bumped to 2025.12.13-01; cache bump to dashboard.js v=2025-12-13-02.
- Admin hosts: fixed `/admin/#hosts` deep link scrolling the Authorized Hosts table to the top (hiding the All/Secure/Insecure tabs); cache bump to dashboard.css/dashboard.js v=2025-12-13-01.
- Admin insecure-hosts “Toggler” modal: fixed enabled hosts showing “Online: expired” by returning timezone-aware `insecure_enabled_until` timestamps from `/admin/hosts/insecure`.
- Admin settings: fixed Canonical AGENTS.md panel leaking onto the Dashboard after navigating away from Settings → Agents (HTML nesting bug).

# 2025-12-12
- Admin dashboard: Estimated Total now auto-selects Plus/Pro from the ChatGPT usage stats; removed the manual plan toggle buttons; savings badge is now inline (“X% Saved!”).
- Admin hosts: fixed the Insecure Hosts “Toggler” enable button requiring two clicks by using the server-provided active flag for toggle state.
- Ops/debug: `public/mtls-debug.php` now returns 404 unless `CODEX_DEBUG=1`.
- Auth runner: probe now uses `-s read-only` and no longer bypasses approvals/sandbox.
- Repo: filled GPLv3 appendix placeholders in `LICENSE` with 2025 + Christian Reiss.
- Admin settings: configurable inactive-host pruning window (0–60 days) now overrides `INACTIVITY_WINDOW_DAYS`.
- Admin logs: Client Reports cost column now rounds to 2 decimals; cache bump to logs.js v=2025-12-12-04.
- Admin hosts: VIP indicator is now a plain 👑 (no badge/pill) in the Authorized Hosts list and host detail modal; cache bump to v=2025-12-12-03.
- Admin dashboard: added Plus/Pro plan pricing (`CHATGPT_PLUS_PLAN_COST`, `CHATGPT_PRO_PLAN_COST`) and color-coded monthly “Estimated Total” vs plan with a “% saved this month” badge.
- Admin access: removed `ADMIN_REQUIRE_MTLS`/`DASHBOARD_ADMIN_KEY` and standardized on `ADMIN_ACCESS_MODE=mtls|none`.
- Admin access: accept colon/dash formatted mTLS fingerprints from proxies (normalize to hex before validating).
- Admin config builder: fixed “Save & Deploy” HTTP 422 sha mismatch when saving immediately after edits (stale preview SHA); the save flow now uses the *saved* sha for optimistic concurrency (instead of the preview hash), and admin assets are cache-busted so browsers actually pick up the fix.
- Admin insecure-hosts “Toggler” modal now shows remaining online time under enabled host FQDNs.
- Removed admin passkey/WebAuthn system: deleted passkey endpoints, DB table, dashboard UI, and related dependencies. Admin access is now enforced via mTLS only (`ADMIN_ACCESS_MODE=mtls`).
- Config builder UI now shows the actual save error (HTTP status + validation details) instead of only “Save failed”.
- Admin config builder: hide `codex-coordinator` from the “Configured MCP servers” list so only operator-added MCP servers are shown (managed entries remain injected per-host).
- cdx wrapper: when `[otel]` is present in `config.toml`, export `OTEL_*` env vars before launching `codex` so traces can be shipped via OTLP without per-host glue.
- Admin Agents: AGENTS.md now always renders the full file contents, and the Edit button opens a working editor modal (previously the modal markup was missing).
- Admin Agents: replaced the modal editor with inline click-to-edit and a dedicated Save button on `#settings/agents`.
- Admin hosts: add per-host `cdx` model + reasoning-effort overrides (defaults to the fleet-wide config when unset).

# 2025-12-10
- Passkey enrollment/auth now accepts base64url (no more "invalid character" errors) and tolerates http/https origins for the resolved host; client `id` serialization aligns with rawId.

# 2025-12-08
- Settings consolidated into a single tabbed page (Settings/Agents/Slash commands/Memories/config) via embedded subpages; header menu now links directly to Settings. Cache bump to dashboard.css v=2025-12-08-22.
- Settings tabs now inline real content (Agents/Prompts/Memories) instead of iframes; config builder still uses config.js but lives in-page. Header menu still flat. Cache bump to dashboard.css v=2025-12-08-29.
- Added hero/info boxes to Hosts and Settings to match Logs (title + subtitle, no extra controls).
- Settings tabs wired with embed-aware nav (nav.js cache bump to v=2025-12-08-06) so each tab loads its page without showing nested headers.
- Dashboard hero/info box removed; tightened spacing between nav, menu, cards, quota section, hosts and logs bottom padding; cache bump to dashboard.css v=2025-12-08-21.
- Logs dropdown removed (plain link), added on-page tabs for Client vs MCP logs, and cache bumped to dashboard.css v=2025-12-08-17.
- Hosts UI merged into a single page with on-page tabs (All/Secure/Insecure/Unprovisioned), hosts menu entry is now a simple link (no dropdown), and assets cache-bumped to v=2025-12-08-16 / dashboard.js v=2025-12-08-06.
- Header nav simplified to plain text (no pills, no hover fill, no underline), dropdown kept minimal, and lower menu hidden; cache bump to v=2025-12-08-15.
- Admin nav underline forced neutral (no shadows/gradients) and cache bumped to v=2025-12-08-13 to squash lingering green glow on Hosts/Logs/Settings dropdown triggers.
- Admin nav dropdown triggers stripped to plain text (appearance reset, no background image/shadow/filter) with another cache bump to purge lingering green glow on Hosts/Logs/Settings.
- Admin nav pill styles fully removed (no hover background/green glow); dropdown links now sit above content and use underline-only active state.
- Admin nav bar restyled to a flat, square, underline-only look (no neon pills/shadows), with neutral dropdowns and a fresh CSS cache buster so the new styles load immediately.
- Admin nav bar flattened to plain text links with square hover dropdowns (no gradients/shadows, dropdowns sit flush under the trigger) so Hosts/Logs/Settings stop looking like glowing bubbles.
- Added dedicated admin pages for Hosts, Memories, Settings (alongside existing Agents/Prompts/Logs) so every menu item opens a real subpage instead of query-driven views.
- Dashboard cost cards moved out of the ChatGPT section: input/output/cached token totals and estimated total USD now show as top-level info boxes alongside Hosts/Versions/Tokens (with cost trend button).
- Admin dashboard hero is back (Dashboard · Fleet overview) with a square, flush menu bar (`Overview/Hosts/Logs/Agents/Slash commands/Memories/Settings`) wired to the existing `?view=` routes; active highlighting now covers the new tabs.
- Admin dashboard: split AGENTS.md and Slash Commands into dedicated pages (`/admin/agents.html` and `/admin/prompts.html`) instead of embedding them on the dashboard/hosts views; navigation links now point to the standalone editors.
- cdx quota summary now lists 5h, day, and week in that order (aligning with the daily allowance view) and bumps wrapper to 2025.12.08-01.

# 2025-12-07
- Added Quota Policy week partition (Off/7d/5d) that splits the weekly ChatGPT window into a daily allowance; `/admin/quota-mode` + `/auth` now carry `quota_week_partition`, dashboard gets a selector, and `cdx` shows a third quota bar that obeys warn/deny policy.
- Admin MCP access log table now shows UTC timestamps as `dd.mm.yyyy, hh:mm:ss`, resolves host IDs to FQDNs, and opens a detail modal when you click a row so you can inspect request/error context without squinting at the list view.
- Admin config builder: fixed change detection so settings-only updates (e.g., toggling managed MCP injection) persist even when the rendered TOML hash stays the same; the UI now sends the rendered sha256 on save, keeps the blank reasoning-summary option truly blank, and hides the managed `cdx` MCP entry just like other reserved servers.
- MCP streamable HTTP now advertises underscore tool names (`memory_store|memory_retrieve|memory_search`) that satisfy the MCP/OpenAI tool regex (`^[a-zA-Z0-9_-]+$`); dot aliases remain accepted for calls, and coverage was added to guard the naming rules.
- MCP resource browsing/templates added: `/mcp` now implements `resources/templates/list`, `resources/list`, and `resources/read` for host memories (`memory://{id}` URIs, text/plain), so MCP clients can enumerate or fetch stored notes.
- MCP `memory_store` now accepts a bare string payload in MCP `tools/call` (`arguments: "note text"`), wrapping it as `content` for convenience; still validates full object bodies.
- MCP `memory_search` also accepts a bare string payload and maps it to `query`, so `arguments: "foo"` works alongside the object form.
- Added MCP method aliases `list_tools`/`call_tool` (and dot variants) plus capability flags (`tools.list`/`tools.call`) so clients using either naming scheme are supported.
- Added MCP aliases for resource templates: `list_resource_templates` and `resources.templates.list` now map to `resources/templates/list`.
- Added MCP resource creation (`resources/create`, aliases `resources.create` and `create_resource`) that writes `memory://{id}` URIs to the memory store from text content.
- Added MCP aliases for resource listing: `list_resources` and `resources.list` now map to `resources/list`.
- Added MCP aliases for resource reading: `read_resource` and `resources.read` now map to `resources/read`.
- Added MCP resource update (`resources/update`, aliases `resources.update` and `update_resource`) to overwrite a `memory://{id}` with new text content.
- Added MCP resource delete (`resources/delete`, aliases `resources.delete` and `delete_resource`) which overwrites the memory with empty content to mark deletion; true DB delete can follow later if desired.
- Added MCP tool `fs_read_file` (alias `fs.read_file`) to read text files rooted at the app directory; includes path normalization and outside-root guard.
- Added MCP tool `fs_write_file` (alias `fs.write_file`) to write text files under the app root with create/overwrite flags and path escape protections.
- Added MCP tool `fs_list_dir` (alias `fs.list_dir`) to list directory entries under the app root with optional glob filtering.
- Added MCP tools `fs_file_exists` / `fs_stat` (aliases `fs.file_exists`, `fs.stat`) to check existence and stat paths under the app root with size/mtime/type metadata.
- Added MCP tool `fs_search_in_files` (alias `fs.search_in_files`) to find string matches under a root with optional glob filters and capped results.
- Added MCP memory tools `memory_append` / `memory_query` / `memory_list` (dot aliases supported) for scoped note storage, querying, and listing with per-resource tagging.
- MCP memory tool responses are now returned as MCP `content` blocks (text payload) to satisfy clients expecting CallToolResult.content.
- Added MCP resource tools (`resource_read|create|update|delete|list`, dot aliases) that wrap the resource endpoints and return MCP content blocks.
- `fs_search_in_files` now matches glob filters against filenames and relative paths (e.g., `src/Database.php`).
- MCP reasoning summary now normalizes per model: `gpt-5.1-codex-max` is forced to `detailed`; other models accept `auto|concise|detailed`; invalid/`none` values are stripped.

# 2025-12-06
- Fixed the admin config builder to only emit valid `reasoning.summary` values (`auto|concise|detailed`), drop legacy `none`, and normalize previously stored configs so OpenAI no longer rejects uploads.
- Repaired `ClientConfigService::retrieve` (broken PHP parse, restored baked/base SHA logic + cache) and added coverage for reasoning summary normalization.
- Removed the Model Providers section (we only ship ChatGPT/OpenAI), so builder no longer accepts provider blocks and server drops `model_providers` entries when rendering config.toml.
- Defaults box now only asks for Model + Reasoning Effort + Reasoning Summary; default profile and model provider inputs were removed since we always target ChatGPT.
- Notices are now always hidden (gpt5 migration + rate-limit nags), with the toggles removed from the builder UI.
- Feature toggles now have human-readable labels while keeping their underlying config keys intact.
- Dropped the OTEL environment input from the MCP/Telemetry card; OTEL environment now defaults to blank.
- Managed MCP now uses native HTTP (no npm): baked config injects `[mcp_servers.cdx] url="{base}/mcp" http_headers = { Authorization = "Bearer {host_api_key}" }`, replacing the broken `npx codex-orchestrator-mcp` shim.
- `/config/retrieve` now bakes `config.toml` per host using that host’s API key for the managed MCP entry, returns both `baked sha256` and `base_sha256`, and only ships content when the baked hash changes (host API key rotation forces a refresh); docs/tests updated.
- Added a dedicated admin config builder page (`/admin/config.html`) that captures every known `config.toml` knob (model/provider/profile, approval policy, sandbox, features/notices, shell env policy, model providers/profiles, MCP servers, OTEL, custom blocks) with live server-side rendering + SHA/size preview and one-click deploy to hosts.
- Added an iPhone-style toggle in the config builder to prefill a managed `codex-memory` MCP server pointing at this coordinator (npx command + API base); hosts get it baked automatically unless disabled, with per-host API key injected at config sync time (no key stored server-side).
- Added canonical `config.toml` storage (`client_config_documents` table) with `/config/retrieve` for hosts and `/admin/config` + `/admin/config/render|store` for admins; docs (API/DB/cdx/overview/README) updated accordingly.
- `cdx` now syncs `~/.codex/config.toml` from the server (warns on offline/missing-config, deletes local files when the server reports `missing`); wrapper bumped to 2025.12.06-01.
- Covered the new ClientConfigService with unit tests.
- Rebranded the admin dashboard and logs page titles to “Codex-Coordinator” instead of “Codex-Auth” so the UI matches the product name.
- Added MCP-compatible memory storage for Codex: `/mcp/memories/store|retrieve|search` reuse host API keys, persist notes in MySQL with full-text search over content/tags, and support tagged filtering so Codex MCP clients can sync memories across sessions.
- Added an Admin dashboard Memories panel (filter by host/tags/query, limit results) to browse stored MCP memories without shell access.
- Documented the new memory API (API/DB/cdx source-of-truth docs, README) and covered MemoryService with unit tests.

# 2025-12-05
- Rebuilt the Quota Policy card into an Operations & Settings panel that now hosts the quota toggle, API kill switch, runner trigger, seed auth.json action, and version check instead of scattering those controls across the header; the entire panel is collapsible (hidden by default) to keep the dashboard compact.
- Moved the insecure-host enable window slider into the same Operations & Settings panel, persist the selection locally (2–60 minutes), and pass it along whenever an insecure host is re-enabled.
- Expanded the AGENTS.md editor modal with a wider layout and taller textarea so editing lengthy instructions isn’t cramped.
- Removed the AGENTS.md SHA display from the dashboard meta line to keep that info box focused on update time and size.
- Added a quota limit slider under Quota Policy (50–100%, default 100%) so admins can warn or hard-stop Codex runs before hitting 100% usage; `/admin/quota-mode` now persists both `hard_fail` and `limit_percent`, `/auth` responses include `quota_limit_percent`, and the logs page no longer shows the orphaned API toggle.
- Updated `cdx`/wrapper summary and quota logic to honor the new `quota_limit_percent` threshold (and new env override `CODEX_QUOTA_LIMIT_PERCENT`), raising warnings or blocking launches once the configured percent is used.
- Hosts can now be marked VIP via the dashboard or `/admin/hosts/{id}/vip`; VIP hosts always run in warn-only mode regardless of the global quota setting, carry a “VIP” chip in the UI, and the flag is included in `/auth` responses + docs.
- Fixed the wrapper’s quota summary logic so it no longer uses `local` outside a function (`bin/cdx`/`storage/wrapper/cdx`), preventing the `/usr/local/bin/cdx: line 3629: local: can only be used in a function` error when running on insecure hosts.
- Admins can now pick a 2–60 minute insecure-host window via the dashboard slider; `/admin/hosts/{id}/insecure/enable` accepts `duration_minutes`, the server persists `insecure_window_minutes`, `/auth` extends windows by that duration (default 10), and docs/UI/CHANGELOG were updated accordingly.
- Added canonical AGENTS.md storage on the server with `/agents/retrieve` for hosts and `/admin/agents` (+ dashboard modal) for admins; hosts replace `~/.codex/AGENTS.md` on every sync and delete stale copies when the server copy is cleared.
- Dashboard now shows an AGENTS.md panel with inline preview + edit modal so project instructions can be updated without shell access.
- cdx pulls AGENTS.md alongside slash commands (python required), handles offline/missing-config gracefully, and surfaces sync status in the boot summary; wrapper bumped to 2025.12.05-01.
- Updated source-of-truth docs (API/DB/cdx) and README to reflect server-managed AGENTS.md instead of the old manual sync script.

# 2025-12-04
- Reformatted ChatGPT quota reset labels to read naturally (e.g., “Resets in 5 days (Tuesday)” and richer sub-48h phrasing) instead of the old “5d 13h 54m to reset” timer text.
- Added `scripts/sync-agents.php` to sync the repo’s `AGENTS.md` into `~/.codex/AGENTS.md` (honors `CODEX_HOME`) so Codex always picks up the latest project instructions with a single command.
- Rebuilt the ChatGPT Estimated Total cost modal with hoverable tooltips, a detailed per-day panel, and a scrolling day-by-day table so you can see exact dates and values instead of guessing from the old coarse chart.
- Added a Slash Commands “New Command” button that opens the creation modal empty, so fresh prompts can be authored without editing an existing entry first.

# 2025-12-02
- Applied the grok.com neon black theme across the admin dashboard + Client Logs views (desktop + mobile) so both screens match the new Grok-branded look-and-feel.
- Rebuilt the Grok theme using the `/root/grok.html` charcoal + teal palette so every dashboard/logs surface (backgrounds, nav, cards, chips, logs, toggles, mobile) now matches grok.com with zero neon gradients left.
- Iterated on the admin styling twice: first with a charcoal/blue corporate pass, then all the way to a light, airy OpenAI-inspired look (white cards, soft shadows, subtle accents) and restored the OpenAI logo in both dashboard + logs headers, keeping desktop/mobile in sync.
- Reshaped the ChatGPT usage summary so the Input/Output/Cached cards mirror the Estimated Total box and now show Today/Week/Month token counts (no more per-card cost rows or USD heading).
- Estimated Total now reports actual ChatGPT costs (using pricing_day/week/month_cost + currency) with Today/Week/Month cost chips instead of duplicating token counts.
- Simplified the Authorized Hosts table headers so the sort controls look like standard clickable text (no chunky buttons) for easier scanning.
- Converted the Authorized Hosts column sorters to plain text links (with keyboard support) so the remaining “button bubble” chrome is gone across browsers.
- Updated table hover highlights to a light orange accent so row selection/hover states match the airy theme instead of the previous dark blue wash.
- Restyled the Authorized Hosts table to stick with the green accent palette (header gradient + green row fills/hover states) so the list feels cohesive with the rest of the admin look.
- Swapped all button hover states (nav + standard + “ghost” controls such as Logs/Seed/New Host) to the green accent gradient so the old blue dip is gone.
- Tweaked the cdx CLI (bin + seeded wrapper) so insecure hosts treat expected auth refreshes as normal: no more “updating auth / auth outdated” noise in the command/result/auth rows, and the auth status tone stays green unless there’s a real problem.
- cdx shell/code launchers: Unknown / not found in code (current wrapper does not implement `cdx shell` or `cdx code`; superseded by later profile shorthand + `--execute` flows).
- Boot summary rows are now deduplicated, sorted, and easier to read while keeping the quota bars untouched.
- Fixed `cdx --execute` so `--skip-git-repo-check` is passed after `exec`, matching Codex CLI expectations.
- Fixed cdx runner telemetry so the status line reflects the fresh verification time immediately after the runner is triggered.
- cdx now shows “auth runner just verified” when the runner completed within ~90 seconds, replacing “<1m ago”; wrapper version bumped to 2025.12.02-01.
- Admin dashboard adds a “Quick: Insecure hosts” menu action (only visible when insecure hosts exist) that opens a scrollable modal listing insecure hosts (FQDN + enable/disable) with active windows pinned to the top.
- Added `GET /admin/hosts/insecure` for a minimal insecure-hosts list suitable for quick UI actions.

# 2025-12-01
- Estimated Total card no longer repeats the month-to-date total in its header, relying on the breakdown chips below.
- cdx now treats `/auth` HTTP 5xx/network outages as offline, keeping cached auth usable and surfacing the offline reason instead of hard failures.
- Slash command sync reports API outages/HTTP 5xx as offline (warn) and the wrapper version is bumped to 2025.12.01-03.
- Token usage ingests now compute and persist per-entry/aggregate costs from configured pricing (with backfill for existing rows) and expose a Cost column + currency on the Client Logs page.
- Auth runner preflight now runs every ~8 hours (first non-admin request per window) instead of once per UTC day, still refreshing the cached GitHub client version; interval configurable via `AUTH_RUNNER_PREFLIGHT_SECONDS` (default 28800s).
- Restyled the ChatGPT month-to-date cost cards with balanced tokens/cost lines and a dedicated total header, replacing the squished four-box layout.
- Estimated Total graph now opens a dedicated 60-day cost trend (input/output/cached) instead of reusing the quota chart placeholder.
- Added a stats icon to the ChatGPT estimated total card to mirror the weekly limit affordance.
- ChatGPT estimated total icon now opens the quota trend chart, matching the weekly limit graph control.
- Authorized Hosts table headers are now clickable to sort (toggle ascending/descending) by host, last seen, client, wrapper, or IP.
- Refreshed the ChatGPT estimated total card with a highlighted primary figure and chips for Today/Week/Month breakdown.
- Admin overview now includes daily token/cost totals for the dashboard, and the ChatGPT cost card shows Today/Week/Month estimates without the previous “includes” blurb.
- Added bash 4.2-safe guard for wrapper release tag selection to prevent `candidate_tags[@]` nounset errors during Codex refresh, and bumped wrapper version to 2025.12.01-02.
- Installer now selects the extracted Codex binary (skipping the tarball) and tolerates empty user lists on bash 4.2 by guarding array expansion in cdx, preventing nounset crashes during install/version checks.
- Fixed installer curl invocation to avoid `curl_flags[@]` unbound variable errors on older bash releases (e.g., CloudLinux 7) when IPv4 forcing is unset.
- Fixed installation UUID bootstrap to reuse existing `.env` values and avoid chmods that broke web-user access, preventing API 500s when env files were unreadable.
- Added installation UUID enforcement (server + baked cdx) to prevent cross-instance mixups; `/auth` rejects mismatched `installation_id`, installers/cdx carry the UUID.
- Added persistent IPv4-only host toggle (admin API + dashboard) that clears IP binding and bakes wrappers/installers with `curl -4`; cdx fetches updates over IPv4 when set.
- Aligned Logs header button styling with other admin controls.
- Installation UUID now auto-generates at boot/migration via shared helper, ensuring `.env` is populated across entrypoints without manual edits.
- Dashboard now shows weekly and month-to-date cost estimates side-by-side (using pricing + token usage) instead of daily totals.
- ChatGPT usage cost card now renders separate lines: “X$ this Week” and “Y$ this Month” for clearer readability.
- Weekly cost now uses the ChatGPT weekly limit window start (when available) instead of a naive trailing 7-day slice for more accurate estimates.
- Backups: the `mysql-backup` sidecar now runs by default, writes to `${DATA_ROOT}/backups`, and replaces the host cron helper; `docker compose up` automatically schedules nightly dumps (tuned via `DB_BACKUP_*` env vars) and setup/docs were updated accordingly.
- cdx wrapper: pass per-host reasoning effort via `--config model_reasoning_effort=...` (current Codex CLI standard) instead of the legacy `--reasoning-effort` flag; wrapper bumped to 2025.12.29-01.
- cdx wrapper: accept token-only auth.json (tokens.access_token or OPENAI_API_KEY) during local validation so fresh `codex login` files aren’t deleted before sync; wrapper bumped to 2026.01.02-01.
- Auth: `/auth` store now runs the auth runner before persisting; runner failures/unreachable responses reject the upload (admin `/admin/auth/upload` still bypasses the runner).
- Auth: when `last_refresh` matches canonical but the digest differs, `/auth` retrieve now asks the host to upload and runner‑validated stores may update canonical on timestamp ties.
- Admin config builder: write/read `features.experimental_windows_sandbox` (Codex 0.79+), drop the deprecated `enable_experimental_windows_sandbox` key from generated configs; cache-bumped config.js v=2026-01-07-02.
- cdx wrapper: sync Skills as `~/.codex/skills/<slug>/SKILL.md` (directory format) with frontmatter metadata parsing; wrapper bumped to 2026.01.09-01.
