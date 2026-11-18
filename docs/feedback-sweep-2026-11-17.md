# Feedback sweep — 2026-11-17

Run `3325c500`, coordinator Adelina. Source audit for the combined maintenance release.

The initial queue contained 39 open reports and no in-progress work. Original
reports and append-only histories were read before triage. Five reports were
added during this run: Advisor Tier 5, secret-search limit forwarding, another
Advisor-progress duplicate, the two proven name-cleanup producers, and the room
roster fixture. All **44** originals/histories were read back at the source-audit
checkpoint: **17 fixes awaiting operational acceptance, 17 saved duplicates,
seven saved blocked outcomes and three saved dismissals**.

This document records source evidence, not a prediction of its own eventual
release SHA. The parent closes fixed canonical reports after merge/deployment
and reads each saved outcome back. Their `fix_ref`, `verification`,
`deployment_ref` and saved final state are the operational record. Publication,
installation and active native adoption are distinct checks. Immediately before
the final deployment the open/in-progress queue must be checked again, as the
operator explicitly requested.

## Per-report source and triage ledger

“Code fix” describes implementation readiness at this source snapshot. It does
not claim that a running host already adopted the binary.

| Report | Title | Disposition at source checkpoint | Fix reference or canonical duplicate |
| --- | --- | --- | --- |
| `86c4ccc0-3ad4-4622-afe0-dea280024011` | Claude session stops taking incoming calls after an orchestrator restart during the session | blocked | — |
| `bd26754c-9a2e-428e-b12e-b20e8092a572` | claims/status and context/get consistently return server_error while acquire and self work | Code fix; runtime acceptance pending | `161d50574c358cd9da0a1b64b182185d6859670e` |
| `00172927-1e64-4528-8644-ac71f5f824f3` | Active claim status and context/get return server_error during production migration | duplicate | `bd26754c-9a2e-428e-b12e-b20e8092a572` |
| `aaba755d-159e-44fe-bcec-6182f9b05fb5` | Immediate peer coordination stays queued throughout a long active Codex turn | Code fix; runtime acceptance pending | `8e0b66850b81d4959847d8aca7b7a77567c56f85` |
| `119abfd9-99ad-43d6-a8de-156ff6e597e6` | secret_search returns nothing for a multi-word purpose query whose words all occur in the secret's name and tags | Code fix; runtime acceptance pending | `bf97d762d2b0e27885fe2e5f35f358f7d7d319a1` |
| `b9a93e21-a62b-40e9-b604-a03c619116ed` | Slop card-kit gives native modal backdrop a generic P1 repeated-card finding | Code fix; runtime acceptance pending | `f702cd936543bed26a0e71b5b6bd9724c1485142` |
| `d83419dc-5540-4076-8e72-69ffc31c002b` | Desktop-Chat erhält Fleet-Policy ohne Werkzeuge für verpflichtende Claims | Code fix; runtime acceptance pending | `ca8c23e126f614cb384a078868d0592f917e732e` |
| `bf3fefd7-0896-4c29-900b-66d5913c4fd8` | Screenshot basename in Advisor evidence incorrectly makes full Slop run incomplete | Code fix; runtime acceptance pending | `f702cd936543bed26a0e71b5b6bd9724c1485142` |
| `65ea91c4-5b4b-46ea-9a7a-cefb7b0e921e` | Desktop-Aufgabe ohne cxx-agent-Werkzeuge und verwaltete Sitzung blockiert Claims | duplicate | `d83419dc-5540-4076-8e72-69ffc31c002b` |
| `a2539475-65ba-491b-b529-71acb8f51e9b` | agent_session_name keeps stale task title after /clear; peers misroute work by it | Code fix; runtime acceptance pending | `8e0b66850b81d4959847d8aca7b7a77567c56f85` |
| `daacb306-da63-4e37-a4a9-e78b1af45a6f` | Slop PostToolUse hook rejects files in linked Git worktrees ("Target outside project") | dismissed | — |
| `662ce3eb-8e8d-41ad-b051-de08a2a42efb` | Slop PostToolUse hook cannot scan linked worktrees ("Target outside project") | duplicate | `daacb306-da63-4e37-a4a9-e78b1af45a6f` |
| `ec11d65f-cf78-4c40-96f0-9e87c03853fd` | agent_work_state returns server_error for current task working report | blocked | — |
| `c3d5679b-2f46-4090-be9f-a63fa746845a` | resource_claim_status hangs 35s while agent_self immediately reports host ineligible | blocked | — |
| `f8a1662d-3766-44f7-b553-5560c864af83` | BrowserOS act fill reports success but leaves input empty | dismissed | — |
| `4863abe3-f510-4900-b778-482f54f86926` | agent_cancel returns internal server error for an already completed work conversation | blocked | — |
| `4971e678-e309-4cef-876c-e981fa2cfc28` | Provide supported review coverage for terminal UIs | Code fix; runtime acceptance pending | `f702cd936543bed26a0e71b5b6bd9724c1485142` |
| `0fe674fd-09ec-430b-b8c2-e2023d9d0e33` | Stale peer worktree registration stays "active" for hours and reports overlap | dismissed | — |
| `28bdb2ea-212a-4e48-9af0-967b104b57d1` | resource_claim_status returns Internal server error for waiting connection claim | duplicate | `bd26754c-9a2e-428e-b12e-b20e8092a572` |
| `2af367d6-1311-46d4-8ac5-a2b466d260c8` | project_card_claim ignores successful agent_context_update to linked worktree | blocked | — |
| `ecd9736a-6dfe-4515-9d8c-a60b641a54f5` | Advisor remains starting with no address or diagnostic until closed after 18 minutes | Code fix; runtime acceptance pending | `90fa03f396db6cade6340f74077a0965a54214e8` |
| `b562738a-16b0-4cc8-9bd2-5128cdf8f804` | resource_claim_status returns internal server error for active connection claim | duplicate | `bd26754c-9a2e-428e-b12e-b20e8092a572` |
| `94d5d567-e60c-4f0d-9c0e-2d197550f373` | claims/status and context/get return server_error for an active connection claim | duplicate | `bd26754c-9a2e-428e-b12e-b20e8092a572` |
| `26e0d13e-c3a8-45d5-b92e-1db3714b0b63` | Native Codex MCP stdio pipes stay closed after shared communicator replacement; same-session gateway works | blocked | — |
| `bf44ec7e-08c2-4881-bb95-ec3c51616865` | agent_context_get and resource_claim_status return Internal server error | duplicate | `bd26754c-9a2e-428e-b12e-b20e8092a572` |
| `37f6bc21-873d-4192-8ae0-319f3ee8c65f` | Full API suite has five existing managed-agent guidance fixture failures | Code fix; runtime acceptance pending | `8d3829d27c7955270ec4229e0ef8687832686856` |
| `0028b453-f769-49ee-8801-d0444dacdc99` | Advisor remained starting without an address or turn for seven minutes | duplicate | `ecd9736a-6dfe-4515-9d8c-a60b641a54f5` |
| `da3a7aeb-4253-4a9d-81ab-2ec85f739a49` | Advisor remains starting without address, verdict or diagnostic for over seven minutes | duplicate | `ecd9736a-6dfe-4515-9d8c-a60b641a54f5` |
| `1b5b6ff5-96ca-4e78-8189-9d273e74fa3c` | Advisor startup failed without diagnostic or verdict | duplicate | `ecd9736a-6dfe-4515-9d8c-a60b641a54f5` |
| `b7f31bac-6464-4969-94a6-dff99c9b94ce` | Progress reply on canceled accepted work hides cancellation behind not_accepted | Code fix; runtime acceptance pending | `321b073ee98a56a09b3db19b91cd5a8cebb5cb0b` |
| `01bd8165-7a59-4712-85ff-f5610e79af46` | Accepted-work result requires claim_id absent from advertised MCP schemas | Code fix; runtime acceptance pending | `8e0b66850b81d4959847d8aca7b7a77567c56f85` |
| `65d6b107-54b8-43da-81e8-f096faad2af7` | Advisor stays starting about ten minutes then fails without diagnostic | duplicate | `ecd9736a-6dfe-4515-9d8c-a60b641a54f5` |
| `3caddac1-2e33-4807-b474-bcf4c39755cb` | Immediate coordination waited until accepted work ended and made its final report stale | duplicate | `aaba755d-159e-44fe-bcec-6182f9b05fb5` |
| `22f5054b-b3a2-444d-93af-2fc3efe13add` | Advisor remains starting with no address or diagnostic for over ten minutes | duplicate | `ecd9736a-6dfe-4515-9d8c-a60b641a54f5` |
| `69bad6a1-1864-4075-bbe8-8854e7f17a2f` | Slop full run reports reviewing while advisor stays starting without diagnostics | duplicate | `ecd9736a-6dfe-4515-9d8c-a60b641a54f5` |
| `aff21c5e-e854-4cb2-a829-c2e1c3201625` | Full UI review stays reviewing while advisor stays starting without address or diagnostics | duplicate | `ecd9736a-6dfe-4515-9d8c-a60b641a54f5` |
| `e43e2c19-ef85-4bbe-9c97-0f8a62cf2003` | Slop jobs cannot review terminal UIs: Go sources and text captures are skipped, quick run scans 0 files | duplicate | `4971e678-e309-4cef-876c-e981fa2cfc28` |
| `fc53060a-79e5-449c-920f-4a1ebd060ed1` | Intermittent agent_send HTTP 502 during coordination; stable-id retry succeeds | blocked | — |
| `70319c2e-52ee-4e31-83e4-10b85224a6be` | Slop full review repeats a "focus styling removed" finding on elements that keep a focus-visible ring, with no way to dispose it | Code fix; runtime acceptance pending | `7b572f4195a04047281efa46cf64feac47fdb24a` |
| `9ec6baa0-5c56-4a9f-abfa-689fd0325f4e` | Advisor verdict schema still rejects Tier 5 although fleet model classes and default reviewer include Tier 5 | Code fix; runtime acceptance pending | `90fa03f396db6cade6340f74077a0965a54214e8` |
| `17479f18-d772-4569-91cc-42263fe9154c` | secret_search advertises limit but never forwards it to the search service | Code fix; runtime acceptance pending | `a3b30d6c60272e082efa3405134c12906abe272c` |
| `bf65da89-1e17-482c-ac87-48dc8193085b` | Expose advisor launch progress when a Slop review remains starting | duplicate | `ecd9736a-6dfe-4515-9d8c-a60b641a54f5` |
| `5e8ee552-6c09-46ce-8b6f-ca2b9c074c4e` | Integration fixture cleanup leaks launch-name leases and pool pointers | Code fix; runtime acceptance pending | `ee99cddbfc40221c7e36bb985df43a0c19ce61ac` |
| `d7123fc8-78d6-417d-aae0-99e2da4b6fbc` | Room directory test expects four online engine members but only invites three | Code fix; runtime acceptance pending | `4da84af19e05e0931ba85e8edbd691edbf6e396f` |

## Verification and scope

- **Claims/context:** earlier fix `161d50574c358cd9da0a1b64b182185d6859670e`
  prevents repeated-abandonment marker failures from breaking global
  reconciliation. Current context/status calls, 81 relevant units and three
  real-MySQL regressions were verified. Its explanation of the historical
  incident is a matching inference, not recovered forensic proof.
- **Advisor:** `90fa03f3` adds bounded startup-stage diagnostics, preserves
  failure information and accepts Tier 5 verdicts. Read-only production evidence
  identified a stale inode for the bind-mounted CA bundle: host TLS succeeds,
  the old container bundle fails. Deployment recreates the Advisor with the
  current bundle; TLS verification remains enabled. 115 focused tests passed.
  A completed served-Advisor review remains required operational acceptance.
- **Wrapper messaging:** `8e0b6685` adds explicit task-title replacement and
  the original `claim_id` to advertised accepted-work schemas. Immediate
  admission reports its finite active-turn budget honestly; it does not promise
  unlimited delivery. `agent_wait` remains the supported mid-turn drain.
  Full agentbus/communicator checks and six focused race cases passed.
  Real owner-kill checks covered three installed engines, while the new
  UnixBroker/Stdio harness covers all four; this does not establish live fleet
  adoption.
- **Cancellation:** `321b073e` returns typed HTTP 409 cancellation state/reason
  for progress on canceled accepted work, without accepting or replaying it.
  75 focused API tests, four real-MySQL cases and nine Go regressions passed.
- **Secrets:** `bf97d762` matches all query terms across searchable name/purpose/
  tag fields, with literal SQL wildcard escaping and deterministic ranking.
  `a3b30d6c` forwards the advertised limit. 66 targeted and 147 adjacent unit
  checks passed; the final focused MySQL acceptance also includes secrets
  services/admin routes. No secret values were written into this audit.
- **Slop:** `f702cd93` propagates source/design/screenshot context, validates
  screenshot hashes, resolves unambiguous basenames and reports terminal-source
  coverage honestly. Quick mode scanning zero TUI files is not full coverage.
  `7b572f41` makes focus detection conservative and supports evidence-preserving
  finding disposition. The initial 53 checks and causal five-RED → 27-GREEN
  focus corpus passed. Current source/screenshots and actual served-worker/full
  Advisor acceptance are separate release checks.
- **Guidance:** `8d3829d2` fixes all five pre-existing budget/snapshot/Skill
  fixtures. Earlier `ca8c23e1` already scopes fleet-only obligations to managed
  sessions; current four-engine coverage confirms that behavior.
- **Name fixtures:** `ee99cddb` clears only the deleted fixtures' own leases
  and pool pointers in flag-admission and smart-queue. The actual cleanup
  regression failed with three own residual leases/pointers before the fix;
  the identical regression and 119 affected tests passed afterwards, with the
  foreign host assignment unchanged. A later broad run still found 605 assigned
  names and 632 orphan leases from other preceding fixtures. This fix is not
  evidence that the entire integration corpus is now clean.
- **Room fixture:** `4da84af1` invites every additional member before asserting
  retained-room liveness for all four engines. The identical isolated case
  failed on clean `8364a287` and current `e698407c`, using separate fresh
  MySQL databases. It passed after the test-only fix: one passed, nine filtered,
  2.80 seconds. Production presence rules and assertions were unchanged.

See [the engine audit](engine-maintenance-2026-11-17.md) for integrated suite
counts, native source/artifact evidence, resource guards and tests not run.

## Recorded blockers

- `86c4ccc0`: historical Claude reception loss after API restart lacks the
  original admission/gate traces and served build. Current reconnect tests pass.
- `26e0d13e`: historical MCP stdio closure lacks original exit/signal/stderr
  evidence. Current owner-kill and four-engine broker harnesses pass.
- `ec11d65f` and `4863abe3`: historical work-state/cancel HTTP 500 reports
  lack correlated logs/build identity; current real-MySQL paths pass.
- `fc53060a`: an intermittent send HTTP 502 needs matching gateway/API logs;
  stable-ID retry and nine targeted Go regressions pass.
- `c3d5679b`: the historical host-77 eligibility/status delay lacks the
  original eligibility, native-owner and correlation/queue trace.
- `2af367d6`: current native-bridge workspace proof and regressions pass.
  Existing fix `4f2af2bb` predates the report, so the missing served build,
  principal and original request trace prevent claiming a new causal fix.

## Dismissed scope and expectations

BrowserOS fill is outside this repository and lacks the external version.
The reported Slop hook is neither vendored nor installed here; no external
repository was changed or external issue/message sent. The stale-Git-peer
request assumes heartbeat expiry, whereas current registrations are
connection-owned; absent proof that the original owner ended, removing that
exclusion would weaken the current ownership contract.

## Delivery contract

Target: `main`, remote `origin`. Production:
`root@docker01.uggs.io:/var/docker_data/codex-auth.uggs.io/app`.
Use `scripts/deploy.sh --no-backup --profile advisor`; publish cxx **0.9.182**,
rebuild/restart the complete stack, verify migrations/health and the running
artifact's exact Git commit, then verify Advisor/Slop and record saved feedback
outcomes. The former production commit was
`b388a131694cbb32eb026f69b09183e0e7616552`; rollback redeploys that commit.
No backup, database dump, configuration copy or rollback image is created.
Earlier code does not automatically restore settings removed by data migrations.


## Supplemental operator finding — eighteenth fix candidate

After the initial 44-report snapshot above, the operator reported that Grok
remained in Provider usage after disabling and destroying it. Canonical report:
`9340eb12-c4c8-4044-9dd5-e5a0b7a77016`. This supplemental item does not rewrite
the initial queue counts or claim a new final queue total.

Source inspection confirms a display defect independently of the exact live
Destroy phase: UsageTable rendered all retained accounts (only dimming disabled
ones), Overview counted them, and EngineTable/RunnerStatus iterated every engine.
Suspension intentionally retains accounts/auth/history. Host-side Destroy and
server-side purge are distinct operations; no live purge completion or purge/cache
bug has been established by this source inspection.

The isolated source fix filters all four engines consistently using the existing
fleet-state view, scopes the account count, gives all-disabled panels a management
path and includes engine state in manual Refresh. Management/history remain
accessible and no accounts, credentials or history are deleted. Browser regression
sources cover retained disabled accounts for every engine, tabs/counts, late engine
state, live disable/re-enable, unknown and failed-state fallback, and all-disabled
recovery; existing quota/accessibility/responsive coverage remains in place.

A17 verification passed: canonical frontend check (0 errors, the existing single
Communicator scroll-region warning, 1,101 unit tests, no slop-grep findings) and
all 16 focused Dashboard browser cases. The browser run performed the canonical
production build/copy and retained all five existing responsive/theme/Axe views.
Four actual screenshots were inspected: enabled providers in dark desktop/phone
and disabled Grok in light desktop/phone. Temporary capture controls were removed.
Peak aggregate memory was 2,187,829,248 bytes, with all memory events zero;
preview port 4173 was free after the run. The complete browser/cross-browser
suites were not run for this slice. Served Slop/full Advisor, runtime deployment
and the saved feedback outcome remain release steps. No wrapper code changed;
no additional wrapper version bump is required for this UI fix.

## Served review follow-up — 2026-11-18

Release `5286e0aadc7607e0c7ff34e9e5fb05a0c3eff8aa` was deployed on
`docker01.uggs.io` at 2026-11-17 23:08 UTC. The running API identifies that clean
commit; migrations 0132–0134 applied with 131 total applied, zero pending and
zero drifted. cxx 0.9.182 is published and the actual Advisor binary matches its
served Linux artifact. Both Grok and Kimi remain fleet-disabled.

Full Slop run `ac557223-c522-410f-8add-0b9b2c00ef39` actually completed its
Codex/gpt-6-astra review with verdict `needs_info`; it is not UI acceptance.
Its confirmed P2, `review:90d8960ba1d6d27b`, is tracked as feedback
`e72eaa2b-5066-4f4d-93fc-50595369f72f`: native JSON actions disabled their
controls without announcing validation or saving. Existing phone captures also
missed the actual JSON editor/preview, and the review needed direct keyboard,
recovery, Engines/Runner and all-disabled evidence.

The isolated follow-up adds operation-specific polite status and busy controls,
four delayed-response success/failure browser cases with keyboard activation,
retained-draft retry and duplicate-submit checks, and targeted JSON/preview and
Dashboard captures with accessibility attachments. These tests are prepared,
not yet executed. Canonical frontend checks, revised Full review and baseline
diff, then the follow-up push/deployment and feedback closure remain pending.
Wrapper source/version is unchanged.

### First focused follow-up check and preview regression

A23 QA passed the canonical frontend check (1,101 unit tests, zero errors, the
existing single Communicator warning and no slop-grep findings) and production
build. The focused two-spec browser run stopped at its first failure: 19 passed,
one failed and 20 were not run. The delayed store-failure case had already proved
pending state, retained draft, retry and successful save; validating the resulting
clean JSON then lost its preview. Feedback
`bba07f0e-6c76-4316-8da2-ab9d4e6ab8f3` tracks this distinct existing defect.

The query effect unconditionally reloaded a clean editor, clearing its explicit
preview even for identical data. A24 compares saved status, revision, digest,
content, settings and validation error before reloading a clean editor. Dirty
draft protection remains. A direct regression covers an unchanged refresh,
revision-only invalidation and changed-settings invalidation. This source fix
and the complete two-spec follow-up still require execution.

After that first browser failure, the A23 pressure guard stopped owned processes
at 2026-11-18 00:02:17 UTC: global memory FULL rose above the original 11.45 + 5
baseline twice, ten seconds apart. Last captured aggregate peak was 2,341,908,480
bytes with zero memory events. Own units stopped and port 4173 was free; no cause
is attributed to another workload. No larger automatic retry was performed.

### A24 focused verification

The changed source passed the canonical frontend check again: 1,101 unit tests,
zero errors, one existing Communicator warning and no slop-grep findings. The
canonical production build/copy succeeded. Both affected browser specs passed
all 41 cases with one worker, zero retries, skips, unexpected results or report
errors (78.17 seconds). The original failing assertion remains unchanged; the
direct refresh/revision/settings regression passed too. Five actual scoped
Axe 4.12.1 reports contain zero violations and zero incomplete rules.

All ten targeted captures were manually inspected: actual native JSON pending,
preview and retained error draft at 390px in light/dark mode; disabled-Grok
Engines/Runner; and all three all-disabled tabs. Actual accessibility snapshots
show operation status, disabled duplicate actions, retained JSON, previews and
management paths. The check also retained the existing five responsive/theme
views. These are mocked local browser interactions, not live provider requests
or a physical screen-reader evaluation. Full/cross-browser UI suites were not
run for this follow-up; unchanged backend/Go evidence remains in the main audit.

Aggregate peak was 2,214,744,064 bytes with all memory events zero; own pressure
averages stayed zero. All owned units stopped and port 4173 was free. The
allocator explicitly made relative global PSI deltas log-only for A24 while
preserving the original baseline, hard 3 GiB/Swap0 cap, absolute memory/IO
thresholds and 24 GiB reserve; no VM or Restic action was taken.

### A25 served Full review and baseline diff

Updated Full run `50c6d2b5-6c04-4aff-b75a-0a86b0653791` (sequence 4) completed
at 2026-11-18 00:29:28 UTC with verdict `agree`, zero findings and zero errors.
The actual Codex/gpt-6-astra Advisor completed one turn and closed. It inspected
all 16 supplied screenshots and five scoped Axe reports; all 33 manifest hashes
matched. The review explicitly accepted the operation feedback, retained error
drafts, unchanged-refresh preview behavior and supplied interaction coverage.

The required sequence-2 to sequence-4 diff resolves P2
`review:90d8960ba1d6d27b`, with no new or unchanged findings. The previous
`needs_info` evidence gaps were addressed by actual native-editor phone images,
test assertions/results, accessibility snapshots, keyboard/retry cases and
Engines/Runner/all-disabled captures. The static scan covered seven sources and
explicitly skipped two test fixtures and three unsupported extensions; it does
not test browser behavior. Acceptance relies on the Full inspection plus the
actual focused browser checks, not a zero-count scan alone.

Reports, diff, source/capture hashes and runtime evidence were preserved outside
the disposable Slop job before closing it. The follow-up deployment outcome is
recorded separately in feedback `e72eaa2b-5066-4f4d-93fc-50595369f72f` and
`bba07f0e-6c76-4316-8da2-ab9d4e6ab8f3`. Wrapper version remains 0.9.182.
