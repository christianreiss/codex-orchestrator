# Web chat redesign verification — 2026-11-16

Implementation on biest.eulie.de in the codex-orchestrator checkout, based on
`b388a131694cbb32eb026f69b09183e0e7616552`. No production deployment, push,
commit, API default change, migration or wrapper change was performed.

## Result and checks

- Shared chats have one Send action, an explicit Everyone default, optional selected
  agents and a post-without-replies option. Reply selects the original agent, or
  Everyone for an operator message; confirmed sends reset the selection and
  ambiguous retries preserve the exact request ID and body.
- Direct/shared messages share sender headers, quoted reply links, 65ch reading
  width, 14px text, twenty-line-height expandable previews and full-message copy.
  Clipped content is inert, with a plain accessible preview; attachments remain
  outside the fold. Current prompt/approval/error components are unchanged and
  remain fully visible. Technical membership changes use compact disclosure.
- `cd frontend && npm run check`: 1,101 tests passed; svelte-check has no errors,
  with one existing warning in CommunicatorApiSection.svelte:51. The local slop
  gate has no findings.
- `cd frontend && npm run test:e2e -- admin-room-chats.spec.ts admin-clients.spec.ts`:
  all **53 chat scenarios passed together** on the final implementation (39.8s),
  including copy failures, reactions and pins. During development, the new
  secondary-actions test initially had an ambiguous role=status locator; it was
  scoped by its actual failure text and passed both individually and in the final
  53-scenario run.
- Playwright builds the committed SPA before each run, so `npm run build` also
  completed with the final source. Generated assets in public/admin were updated.
- Browser coverage: Chromium, light/dark, shared chats at 320/390/768/1440/1920px;
  long Markdown/code/table previews at 320/390/1440px, full clipboard content,
  expansion across room switches, quoted replies and focus, recipient selection,
  note sending, unavailable recipients, lost send responses, stable reading
  position and direct chat parity. Axe checks passed on the exercised states.
- Desktop light, desktop dark and mobile light screenshots were visually inspected.
  This is task-level visual evidence, not independent usability certification.
- `git diff --check` passed.

## Full frontend suite remains red

`cd frontend && npm run test:e2e` completed with **495 passed, 12 failed**
(exit 1). The failures were:

| Area | Failure |
| --- | --- |
| Agent messaging watchdog | Fixture expects three panels; four engines render |
| Chatty action request | Expected payload omits Kimi |
| Direct chat reconnect | Initial page returned 500 before the Agents heading; all subsequent targeted chat checks passed |
| Grok gateway copy | Text locator matches two elements |
| Git commit settings | AI Attribution switch remained checked |
| Git Director | Registry denial fixture did not expose the expected control |
| Host detail | Expected page control not found |
| Kimi usage | Expected quota content not found |
| Chatty engine ordering | Expected reorder control not found |
| Native settings | Expected editor control not found |
| Quota emulation | Expected usage content not found |
| Role editor | Expected editor control not found |

The non-chat sources and tests for these failures were not changed. No baseline
full-suite rerun was made, so this does not claim every failure is proven
pre-existing. The direct-chat initial-load failure did not recur in the subsequent
52-scenario targeted run. During the full suite, the preview also logged
ECONNREFUSED for an unmocked request to 127.0.0.1:8488; causality for the page-load
failure was not established. Full-suite acceptance therefore remains incomplete;
these failures were not expanded into unrelated fixes.

## Design review and limits

Applicable rules: NAV-3, VIS-1/2/3/4, INT-3/5/6/7/8, ACC-1/2/3/4.
Fleet Slop job: `50c5f70b-55d4-4da3-aa06-5c89f2e6f5d1`.
Quick review identified seven focus review prompts. Two programmatic chat headings
were given explicit focus-visible rings. The remaining prompts already provide
focus-visible rings in the same class lists (Composer, Timeline and StatusRun);
they are reviewed false positives, rather than missing focus styles.
The final quick run (sequence 3) completed with no new findings; slop_job_diff
confirmed the two heading findings resolved and the five existing-ring prompts
unchanged. Those five were reviewed as false positives, not left as open defects.

The optional full review could not start: after more than seven minutes,
advisor_status for `76b92b24-2a9e-4545-90d1-0f840141d9d1` still reported
starting/busy with no address, conversation, diagnostic, turns or verdict. No
independent advisor approval is claimed. Recurrence evidence was appended to
existing fleet report `ecd9736a-6dfe-4515-9d8c-a60b641a54f5`; the job was closed
to stop the unstarted advisor and delete its temporary review uploads. The
mandatory deterministic scan and direct visual review were completed.

Not performed: manual screen-reader acceptance, real browser 400% zoom, physical
virtual-keyboard checks, cross-browser tests and field performance measurements.
The 320px reflow checks are not presented as a manual zoom test. Backend and Go
checks were not run because no backend or wrapper implementation changed.

To undo the uncommitted implementation, review and revert only its source/docs
and generated asset changes. No existing user changes were present at start;
no backups or rollback images were created.
