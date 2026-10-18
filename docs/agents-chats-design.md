# Agents shared conversations — design and acceptance

This slice follows the Web design standard recorded in commit `d2e66685` (`DESIGN.md`, sections 3–6). That document is maintained on the parallel design workstream; this change does not import or replace its other page work.

| Surface | Pattern and rules | Implementation |
| --- | --- | --- |
| Agents → Chats directory | Master/detail; NAV-3, VIS-1/5, INT-7 | Direct, project, host, group and conference sections in one directory; search, existing engine filters, unread labels and bounded pages. Uses existing shell and tokens. |
| Shared timeline | Conversation; INT-6/8 | Readable 65ch measure, Markdown, timestamps, reply references and explicit delivery status. Earlier-history loading preserves position. New messages wait when the reader scrolls up. |
| Composer | Form; INT-3/5/8 | Per-room drafts, uploads and UUID recipients; passive Send versus explicit answer request. Retry preserves the original payload and ID. |
| Participants and creation | Sheet/dialog; INT-4/7 | Existing focus management and Escape behavior, named actions, conference close confirmation and visible pending failures. Scope membership stays automatic. |
| Files and retained history | Conversation; INT-6/7 | Existing upload/media components and private-content capability. Closed, closing, disabled, stale, denied and failed states use explicit text. |

Automated evidence lives in `frontend/e2e/admin-room-chats.spec.ts`: draft switching, uncertain sends, selected recipients, create/close, no horizontal overflow and Axe checks of the conversation at 1920, 1440, 768, 390 and 320 pixels in light/dark mode. `admin-clients.spec.ts` and `admin-remote-sessions.spec.ts` protect the existing direct/remote behaviors. Browser artifacts are generated in `frontend/test-results`, not committed as product files.

Desktop and phone captures were visually inspected. The design acceptance remains partial: an independent usability reviewer, manual screen-reader pass, browser text resizing/400% zoom and cross-browser manual checks were not performed. Automated Axe coverage is not a claim of complete accessibility conformance. No field-performance claim or production rollout is made.

## Verification record — 2026-10-18, biest.eulie.de

- `npm run check --prefix frontend`: 982 tests passed; no Svelte errors. One existing warning remains in `ScopeRoomView.svelte`.
- Full `npm run test:e2e --prefix frontend`: 230 passed; one new close-confirmation test had an ambiguous dialog selector after adopting the standard sheet. The selector and focus transition were corrected; the final room suite passes all 12 tests, covering five widths in both themes. Existing direct and remote regressions found in the earlier run were fixed and passed in the full rerun.
- `npm run test --prefix api`: 5,158 tests passed, 783 database-dependent tests skipped. API typecheck, lint and build passed; existing lint warnings remain. Stale theme-path, dynamic Library API and model-policy inventories were reconciled with their existing implementation.
- Full `test:db` against a fresh, disposable MySQL 8.4 instance: 1,603 passed, one skipped, two failures in the existing discovery suite. Those two failures reproduce with the unchanged starting commit `325e670e`: fleet counts include 76 sessions left by earlier fixtures (78 rather than 2; 77 without workspace rather than 1). They are not a room-chat regression. All seven new real-DB room tests pass, including native conference fanout deduplication, graceful native/operator closing and old-wrapper refusal. The four new HTTP capability tests pass.
- Migration 0079 was replayed twice successfully. Source-room attachment ownership, private unpublished uploads, stable send retries, membership revocation and equal-timestamp pagination are tested against MySQL.
- Wrapper `go build ./...`, `go vet ./...` and `go test ./...` passed; the final capability/broker changes were additionally checked with both affected package suites (`agentbus`, `agentportal`).
- No production deployment, service restart, push or production migration was performed. The disposable local databases are verification fixtures only. Manual screen-reader and independent usability acceptance remain pending as stated above.
