# Live auth-admission proof correction — 2026-10-23

The operator reported `clx` failing during provider-account assignment with
`POST /auth/sessions -> 409 communicator_outcome_unknown`. On biest the client
was 0.9.123 and the connected protocol-2 owner was 0.9.122. Server logs showed
successful `/auth/sessions` and `/sync/cache` responses in tens of milliseconds;
the rejection happened during local proof validation, after admission.

A read-only live `/sync/cache` probe wrapping `/auth` for Claude account 1
confirmed `resources: []`, `valid_for_ms: 0`, checked at
`2026-10-23T15:53:01.146Z`. The inline canonical native refresh package had
access expiry `2026-10-23T13:37:13.838Z`. No admission was replayed for diagnosis.

The server correctly declined to cache expired OAuth bytes but incorrectly
used their expiry to invalidate the whole fresh proof. The correction applies
the expiry bound only to resources actually retained in RAM. Uncached native
refresh packages stay inline in each live authorized response. Future-valid
cached resources still expire normally; no offline/stale serving or admission
replay is added. Native refresh owners and existing auth writers/CAS remain.

Regression coverage checks the expired known-manifest case, insecure hosts,
mixed content and root/data envelopes, and exactly one live admission outside
the content snapshot. Client expiry refusal is unchanged.

Validation: the full API suite passed 5,407 tests (416 files), with 1,025
database/environment-dependent tests skipped. The final targeted service/route
suite passed all 8 tests. API typecheck/build passed; full lint returned zero
errors and 167 existing warnings, while lint of the changed TypeScript files
was clean. Targeted Go proof validation/expiry refusal checks passed. No schema
change was made and the full real-database suite was not run for this correction.

Fleet feedback: `d3b998b3-9681-432b-9fa0-4d220ee99a21`.

## Deployed and verified

Production main was fast-forwarded under a bound Director lease to
`91ced1b973426eb7fd86d2a8cf44d943a6cda146`. The API-only supervised rollout
(`scripts/deploy.sh --skip-git --service api --skip-wrappers --no-cleanup`)
completed at `2026-10-23T16:03:03.179Z`. The established HOME/Git context was
preserved, and the running image embeds the correct full commit.

- Image: `sha256:0dd2a0d233e32271374d1774f2ea9b93fbcaf47431a1ac99c5d40c03a1dd43f2`.
- Container started at `16:02:55.114 UTC`, healthy; public health check 200.
- At `16:03:40.361 UTC`, the same live read still contained the expired access
  package inline with zero cache resources, but now confirmed `valid_for_ms:
  30000`. This verifies the correction before native refresh changed the data.
- A real interactive `clx --minimal` launch on biest passed account admission
  and reported API/auth/skills/config/runner OK. Claude Code 2.1.309 opened its
  actual Sonnet 5.5 interface and input prompt in the private probe directory.
  No prompt was submitted. The probe was ended normally with Ctrl-C; wrapper
  exit was 0 after 31 seconds, with `auth=uploaded`.
- The native Claude refresh path updated access expiry to
  `2026-10-24T00:03:48.686Z`. No credential was manually refreshed, injected or
  replayed by the diagnostic code.

Wrapper version remains 0.9.123; neither client binary nor owner replacement
is required for this server correction. Existing stale quota telemetry and
host-daemon update notices were warnings and did not block the real launch.

Rollback image `codex-orchestrator-api:rollback-20261023-pre-admission91ced1b9`
retains the preceding image
`sha256:1fb03840c17e802fcb71ecc5ad2d05ee596a54caf8187cef7f760c81f96ee1fa`.
No database/schema restore is needed; preserve newly refreshed canonical auth.
