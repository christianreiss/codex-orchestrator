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
Deployment and final verification are recorded after the tested correction ships.
