# Account quota lifecycle acceptance — 2026-10-20

Implemented for cxx 0.9.112 and all three engines. No real provider limit was intentionally exhausted.

## Verification

- API: full Vitest suite, 5,254 passing tests; database-dependent suites are opt-in and skipped in that command. Typecheck, ESLint (no errors; 147 warnings in the unchanged baseline paths) and API build pass.
- Go: full `go test ./...`, `go build ./...` and `go vet ./...` pass.
- Frontend: Svelte check and 989 unit tests pass; all 286 existing browser tests pass. Four additional focused browser checks pass for the new quota dialog and existing Watchdog controls, including mobile/dark mode, failed-save draft retention, inheritance, PayG suppression, reflow and Axe.
- Disposable MySQL 8.4 on docker01.uggs.io, isolated from production: baseline, all 84 migrations and replay; 47 migration/Watchdog tests passed. Final targeted run: six new quota tests plus 17 native lifecycle tests passed.
- New MySQL cases cover all engines, deduplicated account notices, reset waits, manual stop, PayG suppression, policy revocation and reuse of an existing scheduled execution lane.
- Affected design rules: NAV-1, VIS-1, INT-2/3/5/6/7 and ACC-1/3/4. Browser checks cover the changed settings and dialog; manual and independent review remain distinct below.
- Final contract checks cover API documentation, capabilities, schema/baseline/migration alignment, MCP name registration, managed guidance and WebSocket invalidation.

## Runtime contract and limits

- Old running wrappers do not acquire the new MCP catalog or account binding in place. Start/resume through cxx 0.9.112 to bind the account. An unbound session explicitly reports unavailable.
- Quota observations are provider-dependent. Claude uses native statusline reports only. Unknown/stale observations never become a healthy zero. A capacity failure without a fresh exhausted window does not guess a quota scope or start recovery.
- Reset recovery uses the original native session and existing execution fences; automatic starts require a persistent host. Missing transcripts never create a fresh session. Native subagent restoration remains owned by the parent CLI.
- Actual provider-limit exhaustion and native subagent retention across such an exhaustion have not been reproduced against live provider accounts. Controlled failure/reset tests establish the orchestration behavior, not that external CLI guarantee.
- Browser automation and Axe passed. Independent usability review and manual screen-reader acceptance have not been performed.

## Rollback

The rollout preserves API and quota-cron images as `rollback-20261020-prequota-7e205f5f` and requests a database backup through `scripts/deploy.sh --backup`. Migration 0084 adds nullable quota metadata plus a zero-default attempt counter; it deletes no application data. An image/source rollback may retain these additive columns. Disable account auto-resume or select unlimited to stop pending quota recovery before rolling back.
