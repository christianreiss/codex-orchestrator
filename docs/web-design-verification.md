# Web design implementation and verification

Date: 2026-10-18. Implementation baseline: `26194f6bf796aeb2ea12b5c93780f6106b027269`.

The design authority reviewed for this work is `DESIGN.md` in committed design branch
`codex/design-standard-01a14dd0` at `d2e66685a301d1e6ba9e69139b0bb551d23f3d69`
(SHA-256 `512c029daa5ae80ac518011b4ef7920a92d5584791b06673255bd17b4f213e2e`).
That documentation branch was separate from the implementation baseline; no uncommitted
files were copied from it. This report records implementation and evidence, not a claim
of full WCAG conformance or production acceptance.

## Coverage inventory

`frontend/e2e/design-routes.json` lists every `+page.svelte`, including redirect-only
entries and dynamic pages with deterministic examples. The browser suite compares this
inventory to the filesystem: adding a page without an explicit case fails the gate.
All rows receive direct navigation, one meaningful h1, matching browser title and
page-wide reflow checks in light/dark at 320×844, 390×844, 768×1024, 1440×900 and
1920×1080. WCAG 2/2.1/2.2 A/AA Axe rules run at 320 in both themes, with **all** violation
impacts retained. These are automated checks, not a substitute for manual evaluation.

| Source entry | Example URL |
| --- | --- |
| `src/routes/(access)/api-keys/+page.svelte` | `/admin/api-keys` |
| `src/routes/(access)/people/+page.svelte` | `/admin/people` |
| `src/routes/(access)/secrets/+page.svelte` | `/admin/secrets` |
| `src/routes/(access)/settings/+page.svelte` | `/admin/settings` |
| `src/routes/(activity)/activity/+page.svelte` | `/admin/activity` |
| `src/routes/(activity)/reports/+page.svelte` | `/admin/reports` |
| `src/routes/(agents)/agents/+page.svelte` | `/admin/agents` |
| `src/routes/(coordination)/agent-messaging/+page.svelte` | `/admin/agent-messaging` |
| `src/routes/(coordination)/git-director/+page.svelte` | `/admin/git-director` |
| `src/routes/(coordination)/schedules/+page.svelte` | `/admin/schedules` |
| `src/routes/(coordination)/transfers/+page.svelte` | `/admin/transfers` |
| `src/routes/(library)/library/+page.svelte` | `/admin/library` |
| `src/routes/(library)/library/[type]/[name]/+page.svelte` | `/admin/library/skills/design-fixture` |
| `src/routes/(library)/library/agent-rules/+page.svelte` | `/admin/library/agent-rules` |
| `src/routes/(providers)/accounts/+page.svelte` | `/admin/accounts` |
| `src/routes/(providers)/engines/+page.svelte` | `/admin/engines` |
| `src/routes/+page.svelte` | `/admin` |
| `src/routes/[...legacy]/+page.svelte` | `/admin/logs` |
| `src/routes/account/+page.svelte` | `/admin/account` |
| `src/routes/cli-auth/verify/+page.svelte` | `/admin/cli-auth/verify` |
| `src/routes/dashboard/+page.svelte` | `/admin/dashboard` |
| `src/routes/hosts/+page.svelte` | `/admin/hosts` |
| `src/routes/hosts/[id]/+page.svelte` | `/admin/hosts/1` |
| `src/routes/login/+page.svelte` | `/admin/login` |
| `src/routes/manual/+page.svelte` | `/admin/manual` |
| `src/routes/manual/[slug]/+page.svelte` | `/admin/manual/accounts` |
| `src/routes/password/reset/+page.svelte` | `/admin/password/reset` |
| `src/routes/projects/+page.svelte` | `/admin/projects` |
| `src/routes/projects/[slug]/+page.svelte` | `/admin/projects/fleet-console` |
| `src/routes/projects/[slug]/activity/+page.svelte` | `/admin/projects/fleet-console/activity` |
| `src/routes/projects/[slug]/board/+page.svelte` | `/admin/projects/fleet-console/board` |
| `src/routes/projects/[slug]/documents/+page.svelte` | `/admin/projects/fleet-console/documents` |
| `src/routes/projects/[slug]/reports/+page.svelte` | `/admin/projects/fleet-console/reports` |
| `src/routes/setup/+page.svelte` | `/admin/setup` |

Additional cases exercise all four editable Library types, memories, the Agents graph,
and Messages addresses, groups, conferences and deliveries. The manual test loads the
actual checked-in Markdown for **all 26 manifest entries**, not placeholder bodies.
Redirect entries are checked at their resulting page. The retired `/go` surface is not
reintroduced. Backend integration independently derives all routes and checks HTML
navigation, plus unchanged JSON session enforcement for the collision routes.

## Implemented corrections

| Requirement | Implementation | Verification |
| --- | --- | --- |
| NAV-1 | HTML prehandler on `/admin/agents`; JSON still session-gated | 40 API integration cases |
| NAV-2 | Page/Auth shells own resolved titles; wrapping headings; named project subheadings; embedded Markdown cannot add another h1 | Complete route gate |
| NAV-3/4 | Descriptive disclosure names; project/report/account/coordination history snapshots; existing URL-driven filters retained | List Back/clear-filter regression; existing navigation suite |
| VIS-1/2, ACC-2 | Custom type-size classes registered in both class mergers; semantic text colors retained; 12px compact metadata and 16px reading/composer text | Merge unit regression and Axe in both themes |
| VIS-3, ACC-3/4 | Shared wrapping controls and action rows, 44px coarse-pointer minimum independent of viewport; bounded local table/graph scroll regions; standalone viewport scroller | Ten-size/theme route matrix, phone/hybrid target regression, enlarged standalone text |
| INT-1/7 | Loading empty arrays no longer appear empty; stale table rows retained with refresh error; clear-filter callbacks; unknown counts not fabricated as zero | Loading/empty/403 and list-context regressions |
| INT-2 | Owner field errors associated with controls and linked summary; reset mismatch associated with confirmation; visible editor labels and required metadata | Existing auth/owner paths plus automated semantics |
| INT-3/5 | Shared save state distinguishes rejection from uncertain transport; draft guards for document, policy, native settings and conversation edits; mutation failures persist on pages and overlays | Rejected-save, uncertain-save and navigation-cancel regressions |
| INT-4 | Existing bits-ui modal semantics preserved; scrollable bounded sheets/dialogs; safe Cancel remains first in confirmation | Existing modal/keyboard suites |
| INT-6 | Shared semantic time element includes exact ISO UTC time in accessible name/title; relative display retained | Timestamp usage across list/detail pages |
| INT-8 | Existing per-agent drafts, attachment ownership, stable timeline and idempotency retained; room drafts and pending request IDs survive room switching in memory | Existing client/chat/remote-session suites |
| ACC-4 | Prose width and wrapping; local Markdown table scrolling; reduced motion preserved; named graph keyboard region | All real manual bodies and responsive suite |

Persistent `MutationNotice` is a fallback for actions that previously only emitted a toast;
it stores error text and mutation IDs, never submitted values. Explicit editors additionally
show local save status. Navigation guards retain drafts only in the current browser session;
secrets and message bodies are not added to URLs or durable browser storage.

## Repeatable commands

From `frontend/`:

```sh
npm ci
npm run check
npm run test:e2e -- --workers=4
npm run test:e2e:cross-browser
npm run build
```

From `api/`:

```sh
npm run typecheck
npm test -- test/integration/admin-spa-navigation.test.ts
```

The E2E web server builds this worktree and serves its deployable SPA; it refuses to reuse
an unrelated server. Tests intercept API requests with deterministic fixtures and do not
change production. Firefox/WebKit use a separate Playwright config; CI installs their
system dependencies on Ubuntu. Playwright traces and screenshots remain in ignored
`frontend/test-results/` and are not shipped in `public/admin/`.

## Evidence and remaining acceptance

- API route integration: **40 passed**; API typecheck passed.
- Frontend check: **983 tests passed**, zero Svelte errors or warnings.
- Complete Chromium suite on the integrated source: **239 passed**.
- Complete design suite on the same source: **20 Firefox + 20 WebKit passed**.
  Each browser covers every route/variant at all ten viewport/theme combinations,
  all 26 actual manual articles, and the draft, keyboard, loading/error, touch and
  enlarged-text regressions. Axe A/AA scans retained all violation impacts.
- The host initially lacked WebKit's ICU 74/JPEG 8 runtime. Official Ubuntu
  `libicu74_74.2-1ubuntu3.1_amd64.deb` and `libjpeg-turbo8_2.1.5-2ubuntu2_amd64.deb`
  were extracted to a temporary directory; a temporary launch wrapper supplied them
  only to Playwright's bundled Linux WebKit. No system packages, production services
  or browser security settings were changed. CI uses the normal dependency installer.
- Representative 320px and 1440px light/dark screenshots were inspected. A repeated
  build produced no unstaged differences in `public/admin`.
- The verified source incorporates concurrent Agents navigation/radial-graph work
  through `325e670e`, preserving scope clouds and the removal of the separate
  ScopeGraph. Later concurrent work in the shared checkout is outside this result.

The following require separate evidence and must not be presented as passed:

1. A human screen-reader pass (NVDA/Firefox or VoiceOver/Safari) across the five operator
   journeys below; automated accessibility scans cannot establish screen-reader usability.
2. Independent visual/operator acceptance: inspect a host and repair a simulated issue;
   edit/reload an agent rule; filter and inspect an interrupted delivery; move a project card
   without dragging and save a note; complete first-run owner/auth setup in an isolated install.
3. Real backend write acceptance against an isolated database for critical saves and sends.
   Browser fixtures and the in-process route gate establish UI/routing behavior, not a live
   provider-auth, database or production workflow proof.
4. Field performance (LCP/INP/CLS p75), real-device virtual keyboards and physical 400% zoom
   remain unmeasured. 320 CSS px reflow and 200% CSS text tests are evidence only for those
   conditions. No analytics was installed.

No database migration, production deployment, service restart or push is part of this change.
After integration, rollback is a revert of the delivery merge relative to its second parent
(`git revert -m 2 <delivery-merge>`), retaining the concurrent graph work, followed by
the normal reviewed frontend build/deployment procedure; no data restoration is required.
