# Focused engine maintenance — Sol 6.2, 2026-11-18

Coordinator Leonore; run `4a429c9a-5fdf-49ab-9327-b5c59ae28455`.
This is the operator's focused follow-up to Astra 6.2 maintenance: add Sol 6.2,
deliver to both `origin` and `github`, and deploy the server. Baseline is clean
`main` at `633d9879a5de819dc66a70b5c0348a0e24d52e2d`. Implementation commit
`2e030fd5933b914dc4ddce041f0e30484cf617a3` was reviewed and fast-forwarded into
the original clean `main` on 2026-11-18; ancestry was verified. Remote and
production acceptance are reported separately from this source audit.

## Evidence and decisions

Read-only researcher `research_sol62` observed the native Codex 0.170.0 account
catalog already refreshed with `fetched_at=2026-11-18T08:30:12.965702112Z`.
The researcher did not refresh credentials or trigger the catalog fetch. Cache
SHA-256: `d3b7b6e16221928ef31148af3118c1251a1f55b0fd0f8d2b1f2e946786cbfb51`.

Official sources reviewed on 2026-11-18:

- [Introducing GPT-6.2 Astra and Sol](https://openai.com/index/introducing-gpt-6-2-astra-sol/),
  published 2026-11-17: efficient everyday engineering and unchanged Sol 6.1 API
  pricing support retaining the existing Sol Tier 3 routing class.
- [Codex models](https://learn.chatgpt.com/docs/models) explicitly shows
  `codex -m gpt-6.2-sol`; its Markdown SHA-256 is
  `56dc4b791e918727a0ad69386c2781e7f530ccf083766f8e14ac368abf7fec23`.
- [Codex changelog](https://learn.chatgpt.com/docs/changelog) separates the
  2026-11-17 model release from the 2026-11-18 CLI 0.170.0 release. Observed
  availability in that CLI does not establish a minimum CLI floor.
- [API model reference](https://developers.openai.com/api/docs/models/gpt-6.2-sol)
  Markdown SHA-256: `3c1aa626387fc854be2560f16620f0c913f4a2aa97e8208d4239efd3279fe913`.
  [API changelog](https://developers.openai.com/api/docs/changelog) Markdown
  SHA-256: `26cdb9c04515e331841b6e3ea15f92482fff43fd588ac57890a6b08f7f7a5011`.

The native catalog identifies `gpt-6.2-sol` as `visibility=list`,
`supported_in_api=true`, `upgrade=null`, default `low`, and persistent efforts
`low|medium|high|xhigh|max|ultra`. It remains a direct active registry entry with
no `liveCatalogRequired`, `minCliVersion` or `upgradesFrom`. Tiering: unlisted →
Tier 3; every existing model's tier is unchanged. Older Sol 6.1 and 6 remain listed
without an upgrade directive, so explicit selections and native defaults stay.
The optional latest-family policy resolves Sol 6.1/6/5.6 to 6.2 without rewriting
storage. The greenfield fleet default stays GPT-6 Astra at low.

The public Codex reference gives 500,000 default context tokens; the native
catalog gives 872,000 maximum. Native Codex owns context selection, so no context
override is added. Native audio-input metadata differs from the public API's
text/image description: no audio support is inferred. No authenticated inference
or every-account entitlement is claimed.

## Issue ledger and implementation

| Issue | Research | Implementation | Fix | Status |
| --- | --- | --- | --- | --- |
| CDX-SOL62 | `research_sol62`, read-only | `implement_sol62`, isolated branch `task/sol62-29189894` | `2e030fd5933b914dc4ddce041f0e30484cf617a3` | Fixed; source acceptance passed and integrated into main |

The canonical model-registry addition propagates to API/gateway model lists,
admin defaults, signed launch menus and Model Class Check guidance. Generated
frontend constants, registry snapshot and signed Codex goldens are refreshed;
the built SPA is included. Existing Go consumers already read additive signed
catalog entries: no wrapper binary, wrapper VERSION or native CLI pin changes.
No schema, auth, session or inference implementation changes. Other-engine audit
and retiering are outside this explicit focused scope.

## Verification

- API canonical full suite: `npm test -- --maxWorkers=2 --minWorkers=1` passed,
  exit 0: 585 files passed / 144 skipped, 8,771 tests passed / 1,330 skipped
  (358.52 seconds). `TEST_USE_DB` was unset.
- API typecheck and build passed. ESLint: zero errors, 237 existing warnings.
- Frontend canonical `npm run check`: 1,101 tests passed, zero errors, one
  existing `CommunicatorApiSection` accessibility warning; slop-grep no findings.
  `npm run build` passed through the browser gate and regenerated committed SPA.
- Focused registry/defaults/policy/tiers/managed guidance/frontend parity:
  initial 314/314 passed; added explicit preservation/signed-menu/guidance cases
  passed 52/52; signed golden generation and validation passed 23/23.
- Go `GOMAXPROCS=2 go build -p 2 ./...` and `go vet -p 2 ./...` passed.
  Config/launchpad/modelpolicy consumers: 494 cases passed using `go test -p 2
  -json ./internal/config ./internal/launchpad ./internal/modelpolicy`.
- Built-SPA Playwright `admin-codex-sol62.spec.ts`: final 2/2 passed at 320×900
  and 1440×900 (21.6 seconds). Verified native low on selection, explicit Ultra
  save/reload, enabled older Sol choices and no horizontal page overflow.
  Browser HTTP persistence is mocked; API service tests verify actual store/render
  behavior separately. Both final screenshots were visually inspected.
- Coordinator Slop quick final run `80d8f8c6-4845-42d0-92a9-b15ce66b06d0`:
  zero findings/errors, two sources scanned (generated constants and shared
  QuickModelDefaults); the updated browser fixture and DESIGN.md were supplied
  but unsupported by the quick scanner. Screenshots were supplied and visually
  reviewed separately; quick does not evaluate screenshots or browser behavior.
  Applicable design rules:
  GOV-2, NAV-1, VIS-3, INT-3/5 and ACC-1/4. No UI component, surface or exception
  is added. The complete browser suite, full Advisor review, dark-theme,
  assistive-technology, cross-browser, zoom and field-performance acceptance were
  not run for this catalog-only slice.

The first full API run found three exact HostAgents preview expectations still
naming Sol 6.1 as the latest Tier 3 recommendation. Those expectations now name
Sol 6.2; the configured Sol 6.1 identity assertion remains intact. The narrow
HostAgents check passed 81/81 and the full canonical suite passed on rerun. Existing exact catalog
expectations were expanded without weakening assertions. The screenshot mock's
missing host counts were corrected before the final captures. Real-MySQL suites
(`TEST_USE_DB` unset), complete Go suite, runner suite and authenticated inference
were not run; no schema or query behavior changes are introduced.

## Delivery and rollback

The implementation child committed only its isolated task files, without merging
or pushing. The coordinator verified and integrated that commit into clean `main`.
Delivery covers both `origin` and `github`, final Slop artifacts and deployment on `docker01.uggs.io`
using `scripts/deploy.sh --service api`. Production execution and acceptance are
reported separately from the source checks above. Rollback is redeploying
`633d9879a5de819dc66a70b5c0348a0e24d52e2d`; there is no new migration to undo.
