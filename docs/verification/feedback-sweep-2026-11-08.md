# Feedback sweep — 2026-11-08

Run: Sylvie, agent `41c23c2f-be50-4475-a9d5-8f80b572fd0e`.
Work order: [feedback-sweep](../prompts/feedback-sweep.md).
Base: `cf0c4141bdf1a1531d07e9115dcbe59c40d0a45c` on `main`.
Integration: `feedback-sweep-41c23c2f`; original checkout and peer work preserved.
The operator briefly stopped the run, then explicitly resumed it. Interrupted
checks were restarted; no push or deployment occurred during the stop.

## Queue outcomes

| Report | Outcome | Evidence / fix |
| --- | --- | --- |
| `6615e811-57f9-4e61-baf9-b8b233e247b7` | Blocked | Historical scope context/claim server error needs the original exception or deterministic reproduction. Current context succeeds and 36 coordination tests pass. Current API container starts after the reported event; its logs cannot recover that exception. No speculative fix. |
| `814167c9-17a5-46bd-9129-0105e691eea2` | Fixed | `a21109d4831d7abde476e563f896d56dbc9c0e0a`: normalize optional batching flag; retain anonymous totals with internal hosts; DB configuration fallback for owner-server fixture. Eleven focused MySQL tests passed. |
| `e6b68b0a-971e-4ab3-9d74-674491795a54` | Fixed | `c33c4fcd9`: label supervisor model as launch configuration in wrapper registration and peer projections; interactive model changes are not represented as observed. |
| `bad39b95-f9f8-4f93-aa64-604a48a04be0` | Fixed | `24c91a8a21f6f1822502bdbdb8a16bf7d0825ac5`: exact native-owner proof restores disconnected registrations; commit-time proof fences detach races; unknown outcomes stay excluded. |
| `5222e52e-5b02-4ea3-8352-3e644be55bea` | Duplicate | Canonical report `bad39b95-f9f8-4f93-aa64-604a48a04be0`. Saved and read back. |
| `2a496d29-c8a4-42d0-b24f-d9452a5a0ae9` | Fixed | `cd37cd61ed457e2d54cb0303fdc47801e8a9d8b7`: a11y JSON audit envelope documented; YAML accessibility trees are source evidence. |
| `385ce144-ad9c-48d8-92b9-f2df51617204` | Fixed | Same Slop commit: font heuristic requires declarations and whole font names, with Internal/International/IntersectionObserver regressions. |
| `0d524b44-6354-4c29-b691-c170237778a4` | Fixed | API `f55d1d578`, wrapper `bca482e626ff59d740386f15ba9646810cd655fe`, follow-up `befdc0df3`: current native receiver explicitly adopts one queued peer request/task by ID. Normal admission/exclusive ownership retained; schedules excluded; ambiguous receipts keep the original claim and never submit a second native turn. |
| `1c762fff-9194-4309-a604-c6bf106fd57b` | Fixed | Slop commit exposes coverage and scanned-source counts; unsupported extensions are counted explicitly. Kotlin parsing is not claimed. |

The parent closes fixed reports only after deployment and reads each back.
Fixes are not evidence that the historical blocked error is solved.

Three reports were already blocked before this run and were not reopened:

- `b42fd40d-b18c-45fa-a492-bc358ab2864b`: partial batching fix deployed;
  remaining active-turn rearm needs verified native boundary semantics.
- `3537726a-a9bf-42dc-8bb9-1ad69684b3bb`: original missing-native-proof
  incident lacks original receiver/launch diagnostics or exact reproduction.
- `39100081-1ec9-4f90-b04b-43112c402e9c`: unattended secret provider needs a
  scoped service-identity design decision.

## Verification

- API `npx tsc --noEmit`: passed.
- API `npx vitest run test/unit`: 456 files passed; 6,584 tests passed,
  12 skipped. The first combined run found a missing Slop CI path trigger;
  both trigger filters and vendored scanner dependency installation were fixed.
- `npm run build`: passed, 125 migration files packaged.
- Owner-state Git/coordination tests: 80 passed.
- Wrapper `go build ./...`, `go vet ./...`, `go test ./...`: passed.
- Focused wrapper acceptance/admission race checks: passed.
- Vendored scanner TypeScript check: passed.
- Real-MySQL `npm run test:db`: 207 files passed, 1 skipped;
  2,137 tests passed, 2 skipped (407.71 seconds). No remaining failed tests.
- Disposable DB: MySQL 8.4.13, container `feedback-db-41c23c2f`, loopback
  port 33417, database `codex_test`; baseline and all 125 migrations succeeded.
  CI uses root only in its disposable service because the owner-server regression
  creates/drops its own isolated database. Production grants are unchanged.
- No browser UI was changed by this sweep. Concurrent subagent-selection changes
  already on `main` were merged before integrated checks; their built SPA is preserved.

## Delivery

Wrapper version: `0.9.169`. Deployment target: `docker01.uggs.io`,
`/var/docker_data/codex-auth.uggs.io/app`, via `scripts/deploy.sh --no-backup`.
API and Slop worker must both rebuild. No new migration, manual backup or rollback
image tag is created. Production rollback source is the pre-run
`cf0c4141bdf1a1531d07e9115dcbe59c40d0a45c`; redeploy that revision with the same
no-backup procedure if needed. Deployment verification is recorded in feedback
closure evidence and the final work result.

## Task discovery

`AGENTS.md` now links both complete task prompts: feedback sweep and engine
maintenance. This run executes the feedback sweep. The latest recorded engine
maintenance is [2026-11-06](../engine-maintenance-2026-11-06.md); no new engine
maintenance audit is claimed for November 8.
