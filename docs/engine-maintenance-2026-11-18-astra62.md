# Focused engine maintenance — Astra 6.2, 2026-11-18

Coordinator Leonore; run `0f7344c5-978b-4a18-90a5-dee24c06a7de`.
The operator requested an Astra 6.2 follow-up to the completed engine maintenance,
delivery to both `origin` (GitLab) and `github`, and server deployment.
Baseline: clean `main` at `c12dc2d75457500e1000fe520995d549665c7c6c` locally,
on both remotes and on `docker01.uggs.io`.

## Evidence and scope

Read-only researcher `research_astra62` verified the current
[official Codex model reference](https://learn.chatgpt.com/docs/models) and the
native Codex 0.169.0 account catalog, fetched
`2026-11-18T06:34:51.918198925Z`. Cache SHA-256:
`e76b73667e7ae667fa2124dfdece51396b2a336775e1fb78f72b71140a6d6788`.

- `gpt-6.2-astra` is listed, with `supported_in_api=true`, native default `low`
  and persistent efforts `low|medium|high|xhigh|max|ultra`.
- The catalog reports text/image input and 272,000 default context tokens.
  Codex retains context selection; this change adds no context override.
- No minimum CLI version is stated in either checked source. Version 0.169.0
  proves availability, not the minimum supported version.
- Astra stays Tier 5, following its existing family and the provider's demanding
  end-to-end project positioning. No other model changes tier.
- `gpt-6-astra` remains listed with no upgrade directive. It remains selectable,
  and existing explicit selections and fleet defaults are preserved.
- The opt-in latest-family policy follows Astra 6.2 without rewriting stored
  selections. Other engines and GPT-6.2 Sol are outside this focused request.

## Issue ledger

| Issue | Research | Implementation | Outcome |
| --- | --- | --- | --- |
| CDX-ASTRA62 | `research_astra62`, read-only | `implement_astra62`, isolated branch/worktree | Integrated `c1f0c218485a59ea7e1d23d03affd4dbe421f026` |

The registry drives API catalogs, signed wrapper launch catalogs, effort
validation, tier guidance and generated frontend choices. Existing wrappers
consume the additive signed entry; no wrapper binary change is required.
No auth/session change, schema migration or inference acceptance is claimed.

## Verification and delivery

- Frontend canonical `npm run check`: 1,101 tests, zero errors, one existing
  `CommunicatorApiSection` warning; `npm run build` passed and the generated
  SPA is included in the implementation commit.
- API typecheck/build passed; ESLint passed with zero errors and 237 existing
  warnings. Canonical `npm test -- --maxWorkers=2 --minWorkers=1` passed:
  583 files passed / 143 skipped, 8,735 tests passed / 1,325 skipped,
  332.22 seconds, exit 0; `TEST_USE_DB` was unset. This includes the required
  registry, policy, model-tiers, managed-agents-features and frontend contracts.
- Go build/vet passed with bounded parallelism; config/launchpad/modelpolicy
  consumption tests passed all 481 cases. Wrapper source and version are unchanged.
- Built-SPA Playwright `admin-codex-astra62.spec.ts`: 2/2 at 320 and 1440 px;
  a 320 px screenshot-position follow-up passed 1/1. These use mocked HTTP
  responses; service persistence is checked separately by API tests.
  Verified native low default, explicit ultra save/reload, older Astra choice
  retention and no horizontal page overflow. Both screenshots were inspected.
- Actual source rendering verified the signed launch entry's six efforts and
  low default, and Astra 6.2 in the rendered Model Class Check Tier 5 row.
- Slop quick final run `c4898499-d678-487b-a1ce-06ecc3a188b1`: completed,
  zero findings, two source files scanned. Tests and Markdown were not scanned;
  the quick scan does not test browser behavior. Sources, DESIGN.md and both
  screenshots were supplied. Job closed and temporary transfers retired.
  Applicable design rules: GOV-2, NAV-1, VIS-3, INT-3/5 and ACC-1. No new surface
  or design exception; no full Advisor, dark-theme, assistive-technology or
  cross-browser acceptance was run for this catalog-only change.

The initial unit run exposed three exact catalog expectations missing the new
row; those fixtures were updated without weakening assertions. An initial new
persistence test also hit the fake database's unsorted history; independent
default/explicit-effort cases avoid changing production or the shared fake.
The causal latest-family test failed before the registry addition and passed
after it. Real-MySQL suites and authenticated inference are outside this
catalog-only verification; no schema or database query changes are introduced.
The complete Go, runner and browser suites were not rerun; the bounded checks
above cover the changed catalog and its consumers.

Implementation `c1f0c218485a59ea7e1d23d03affd4dbe421f026` was fast-forwarded
into the original clean `main` under Git Director lease; the coordinator then
added this verification record. The two remotes receive the same release head.
The authorized target is `docker01.uggs.io`, checkout
`/var/docker_data/codex-auth.uggs.io/app`; use `scripts/deploy.sh --service api`.
The previous API/runner and other stack services were healthy. No backup or
rollback image is created. Rollback is redeploying
`c12dc2d75457500e1000fe520995d549665c7c6c`; there is no new data migration to undo.
Production execution and final remote hashes are reported after deployment,
separately from these source/test results.
