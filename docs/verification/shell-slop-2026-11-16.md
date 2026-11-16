# Sidebar and top bar Slop review — 2026-11-16

Work performed on biest.eulie.de in the codex-orchestrator checkout. Existing
uncommitted chat changes were preserved. No commit, push, deployment, API change
or database migration was performed.

## Confirmed defects and corrections

| Finding | Evidence | Correction |
| --- | --- | --- |
| Breadcrumb labels were clipped | Eight baseline viewport/theme checks measured 17–55px of clipped content | Inline wrapping trail with underlined ancestor links, growing header and wrapping actions; short mobile locations keep a compact header |
| Compact rail labels depended on hover | Keyboard test found no visible tooltip | Shared tooltips on primary/utility links; labels and account names wrap when expanded |
| Appearance had no selected-option semantics | Baseline test could not find a checked option | Shared menu radio item with a visible check, checked state and focus ring |
| Theme save failure existed only in a toast | Source inspection of onError | Persistent header alert, rollback to prior theme and an explicit Retry appearance action |
| Main skip-link destination removed focus styling | Slop review prompt and source | Explicit focus-visible inset ring; browser assertion exercises Skip to content |
| Shared tooltip content lacked tooltip role | A visible keyboard hint existed in the accessibility snapshot as plain text | Explicit role=tooltip in the shared primitive |

Report counts also explicitly respect feedback.read when cached query data exists.
The sidebar's navigation groups, routes, palette and engine behavior are unchanged.

## Slop review disposition

Fleet job `c19e3463-07bb-439e-b72c-d97efe75b754`, slop-detector 0.3.1:
initial quick run `3965477b-4d76-4492-9769-4be4f18b1847`, final quick run
`fcf0136a-3059-413e-8831-050805ff7d5b`. Final scan covers 12 source files;
DESIGN.md is supplied as the brief. Screenshots of desktop/light and phone/dark
were uploaded as review evidence and inspected directly.

The scanner produces 24 **review prompts**, not 24 measured defects:

- Two type-default prompts point at Inter @font-face declarations, explicitly
  chosen by DESIGN.md section 4. Keep the documented font.
- The AppShell focus prompt was corrected with an explicit destination ring.
- Remaining outline prompts in app.css, Sidebar, TopBar, mobile controls,
  temporary-access navigation and TabNav already have replacement focus-visible
  rings. The new radio item also has an explicit inset ring and menu highlight.
  These were reviewed as false positives rather than removed to game the scan.
- slop_job_diff confirms the AppShell prompt disappeared; other ID changes track
  moved lines, not extra resolved defects. No confirmed issue is left open within
  this task's scope.

No full Advisor review was launched: the immediately preceding work item verified
its startup unavailable (fleet report ecd9736a-6dfe-4515-9d8c-a60b641a54f5).
This result relies on deterministic Slop, source inspection and direct browser
verification; it claims no independent Advisor approval. The temporary job and
transfer copies are closed/deleted after recording the results.

## Verification

- Initial ten new shell browser checks failed against the original UI, confirming
  the breadcrumb, keyboard-hint and selected-appearance gaps.
- `cd frontend && npm run check`: 1,101 tests pass, no Svelte errors, local slop
  gate clear. One unchanged Svelte warning remains in
  CommunicatorApiSection.svelte:51.
- Shell tests cover 320/390/768/1440px in light/dark, a long project breadcrumb,
  all header indicators, Axe on header/sidebar, keyboard rail hints, 200% text,
  selected appearance, save rollback, durable error/retry and skip-link focus.
- Existing desktop shell/command-palette and appearance persistence/keyboard tests
  are included in the focused verification. Only appearance role locators were
  updated to reflect the corrected menu radio semantics.
- The Playwright setup runs npm run build and refreshes public/admin artifacts.
- Desktop/light, phone/dark, compact-rail keyboard focus and 200% sidebar text screenshots were visually inspected. This is not
  independent usability certification.
- git diff --check passes.

The first broad suite exposed a task-caused link-in-text-block accessibility
regression after switching breadcrumbs to inline text. Ancestor links were then
underlined so they are distinguished without relying on color. The final broad
suite reruns those checks; the final result is **513 passed, 6 failed** (519 tests, 4.6 minutes, exit 1).
All eleven new shell tests, existing desktop-shell/command-palette tests,
appearance keyboard/persistence/rollback tests, all route reflow checks and all
manual-article Axe checks pass. The task-caused breadcrumb regression is fixed.

The remaining failures also occurred before this shell task and concern unchanged
areas: watchdog fixture expects three engines rather than four; Chatty action
payload omits Kimi; Grok gateway locator matches duplicate text; Kimi usage
fixture; Chatty engine ordering; quota-emulation usage fixture. No unrelated
implementation was changed to make these checks pass. The overall suite is still
red and is not presented as a full release acceptance.

Applicable design rules: NAV-1/2/3, VIS-1/2/3/4, INT-3/5/6/7,
ACC-1/2/3/4. No design exception was introduced. Manual screen-reader testing,
actual browser zoom, physical virtual-keyboard testing, other browser engines and
field performance were not measured. Backend and wrapper checks were not run
because those implementations were not changed.

To undo these uncommitted changes, revert only the shell, shared-primitive,
corresponding test/doc hunks and rebuild the SPA, retaining the earlier chat work.
No live service needs rollback; no backup or rollback image was created.
