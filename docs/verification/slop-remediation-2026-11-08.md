# Slop audit remediation — 2026-11-08

The original audit reviewed snapshot `74cfc72f2ca0517ba626fac254c0490194955812`; remediation starts from `8fbdb4d6f012f22353aea7d9fbdbc6424dd8e203`. Work is isolated from concurrent fleet changes. No production deployment is part of this task.

The remediation covers the 43 curated WebUI entries and approximately 20 distinct CLI entries. The CardEditSheet refresh allegation remains excluded: the caller retains the clicked card rather than replacing it on query refresh. Raw scanner suggestions and the incorrect unsupported-communicator-actions clause are not defects to implement.

Draft retention uses guarded dismissal or pending edit locks, with draft-revision checks for editable send/add-card inputs. Hooks preserve each command's own timeout. Canceled AI responses cannot replace the next editor draft; roster generation applies only roster fields. Unknown reads stay unavailable instead of becoming false/empty, failed saves remain inline, pending confirmations retain target context, and operation outcomes retain their actual tone. Source selection/label/clipboard/time/recovery issues are corrected. Duplicate primary empty-list actions use a secondary outline action while retaining the primary toolbar/header entry. URL filters serialize before leaving a list and retain back/forward behavior. Route inventory and the obsolete 403 assertion match current behavior.

CLI help is handled before destructive dispatch, authentication and privilege checks. Stray portal arguments are rejected. Housekeeping pin/unpin rejects unsupported dry-run before altering pins; machine-output branches remain JSON. Empty model catalogs and small terminal notices remain usable. Setup forwards arguments for installer validation; maintenance scripts reject unsupported flags. Generated installers handle help locally, validate platforms before claiming a token, disclose enabled TLS bypass, retain sanitized current HTTP diagnostics and explain missing daemon prerequisites. Readiness validates the response structure; scan errors report incomplete coverage.

## Rule and evidence map

No new surface, design decision or exception is introduced. Existing pages and shared controls follow `DESIGN.md`; evidence below describes exercised subsets, not blanket conformance.

| Scope | Rules | Verification |
| --- | --- | --- |
| List filters, duplicate primary empty-list actions, project Slop rows | NAV-3/4, INT-1, VIS-5 | Canonical route inventory and immediate filter/detail/Back regression; broad Chromium reflow sweep |
| Chatty, memory, secrets, quota, hooks and AI/project drafts | INT-2/3/4/5/8 | Source review; hook timeout unit tests; delayed send/reset, suggestion, AI cancel, project discard and quota dirty-state browser regressions |
| Unknown modules/settings, setup refresh, transfers, schedules, reports, People and board failures | INT-3/5/6/7 | Source review; disabled-until-confirmed, setup draft, delayed card create and audit failure/retry browser regressions |
| Choice cards, selected items, engine status, seed fields, timestamps and clipboard | VIS-4, ACC-1/3, INT-2/5/6 | Source review; clipboard unit tests; broad fixture Axe/reflow checks; existing provider credential browser tests |

## Executed checks

- API: `npm test -- test/unit` — 459 files passed; 6,634 tests passed and 12 skipped. `npm run typecheck` passed. Selective ESLint of changed service sources and the new safety test passed.
- Frontend: `npm run check` passed: 1,057 tests, zero Svelte errors, no Slop grep findings. One existing `CommunicatorApiSection.svelte:51` noninteractive-tabindex warning remains.
- Go CLI: `go build ./...`, `go vet ./...` and full `go test ./...` passed. Fresh safe-help probes: 20 passed, stdout usage, exit 0, empty stderr and no isolated-HOME writes. Fresh terminal fixtures: 451 passed.
- Generated shell regression suite: 23 cases cover local help, pre-token unsupported-platform rejection, argument forwarding/rejection (including seed uploaders and all host-spawn daemon modes), incomplete scan reporting, structural readiness and current sanitized seed-upload HTTP errors/private temporary cleanup. Targeted API service/config tests also passed (121 tests total in the selected five files).
- A complete canonical Chromium run passed 450/453 cases; the three remaining stale assertions were corrected and passed a strict targeted rerun (3/3). Final combined-source canonical `npm run test:e2e -- --workers=4` passed all 453 Chromium cases, zero skipped/flaky/failures, after rebuilding the committed SPA. Earlier design coverage exercised all 42 route entrypoints, 11 variants, five widths, both themes, fixture Axe at 320px and 28 manual articles. Initial filter-history and transfer-audit failures were corrected and passed the strict targeted regressions. A new quota test initially used the wrong route and was corrected to `/admin/limits`.

## Post-fix Full Slop review

Web job `00d055f4-d484-4069-b536-7fef9bd3e514`: four Full runs. The first two revealed four additional supported draft-lifecycle defects (AI prompt/mode edits, project discard, stale quota saved state and Chatty reset); each was corrected. Final run `bc77397a-857b-401f-9088-0f43813e3f36` completed with Advisor verdict **agree**, no material issue in the focused supplied remediation, zero report errors. Four unchanged focus-keyword scanner suggestions include replacement focus/highlight styles and are triaged as false positives, not accepted exceptions. The last run includes the strict immediate-filter reload/Back repair and verifies 61 supplied file hashes. DESIGN NAV-4 wording was clarified after that snapshot without changing behavior or the filter-retention requirement. Runtime acceptance is separate.

A focused follow-up job `94ccb670-92b5-4d15-a200-b441b78f21ea` reviewed the empty-action hierarchy batch and fixture corrections. Final run `91e00bee-00f8-4858-a888-11ccc9e5c61f` agreed with no material source-supported issues and zero errors. Two focus-keyword suggestions have explicit replacement rings. All ten empty-action snippets were inspected; eight additional duplicate-primary actions were switched to outline without changing callbacks or permissions. All review jobs were closed only after retaining raw reports and diffs.

CLI post-fix Full job `dd54a178-0653-4edb-8c88-92cbdb95a267` completed two runs. The first found unsafe help/unsupported-argument handling in the host-spawn and seed-auth outer scripts; both were fixed before privilege, temporary-file, credential and network operations. Final run `11cd1669-3382-4a79-b38a-362ccedfa1a6` completed with zero findings/errors and Advisor verdict **agree**, with 45 supplied hashes verified. Deterministic Slop does not support Go/shell; the Advisor source review, safe probes and terminal fixtures are separate evidence, not runtime certification.

Local raw evidence is retained under `/tmp/cxx-slop-remediation-proof-0282724a/` and `/tmp/cxx-slop-remediation-review-0282724a/` on biest.eulie.de. The current main integration base is `7e30b103ff04b96d0160c4931ac8179d3936c631`. Post-integration Go build/vet/full tests passed (73 successful packages), all 459 API unit files passed (6,634 tests, 12 skipped), API typecheck passed, and frontend check/build plus the complete Chromium suite passed. Incoming RTK installation/cache, Slop import and deployment-provenance changes were preserved. Merge conflicts were limited to documentation, version metadata and generated SPA files; the latter were rebuilt from combined source. cxx 0.9.172 is prepared, without publication or deployment.

No real installation/uninstallation, authentication changes, production migrations, reboot or native provider interaction is exercised. Browser fixtures do not establish all-state accessibility, manual screen-reader, 400% zoom, independent usability or field-performance acceptance.

Not run: `npm run test:e2e:cross-browser` (Firefox/WebKit), manual screen-reader tasks, 400% zoom/text-spacing/virtual-keyboard acceptance, independent usability or field-performance measurement. No accepted design exception or confirmed material Slop finding is left open by this remediation.
