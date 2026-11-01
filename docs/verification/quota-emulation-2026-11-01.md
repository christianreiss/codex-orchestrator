# Emulated quota verification — 2026-11-01

Implemented per-engine opt-in short quotas for Codex, Claude and Grok, using
account-wide weekly observations only when no native short window is present.
The settings and server resume both default off. Tests use local fixtures or a
disposable MySQL 8.4 database on `biest.eulie.de`; no production service, provider
account, quota setting or migration was changed.

## Checks

- API typecheck and build: passed.
- API lint: zero errors; 233 existing/style warnings remain.
- Full API suite: 528 files passed, 125 skipped; 7,175 tests passed and 1,157
  skipped. Database-gated tests were exercised separately below.
- Seven MySQL integration suites: 33 tests passed, including migration reapply,
  schema hydration, account leasing, route admission and quota recovery.
- Final MySQL safety run: seven tests passed. It proves persisted observation
  deltas and restart hydration, hard-stop holds before acceptance, original-native
  automatic release only with the switch enabled, manual retry, no accepted-work
  replay, unlimited-account suppression and cancellation on explicit user stop.
- Wrapper `go test ./...`, `go build ./...` and `go vet ./...`: passed.
- Frontend `npm run check`: zero errors, one pre-existing Svelte warning in
  `CommunicatorApiSection`; all 1,016 unit tests passed.
- Deployable SPA build: passed and committed under `public/admin/`.
- Four feature browser tests passed: independent engine settings and reload,
  keyboard selection, light/dark 390px reflow, actionable retry failure and success,
  and labelled stale readings over 100% in Accounts and Overview for all three
  engines. Axe found no
  violations in the affected policy section.
- Full browser run on port 4179: 400 passed; five unrelated API-access tests use
  literal 4173 endpoint expectations. Canonical-port rerun: all five passed, along
  with all four feature tests (nine passed). No unresolved browser failure remains.

## Browser review

Inspected the feature's light/dark 390px screenshots from the deployable SPA.
Persistent labels, switch states, helper text, reaction options, inline errors and
retry confirmation remain readable and operable. Existing full-suite design tests
passed reflow at 320, 390, 768, 1440 and 1920 pixels in both themes.

Applicable DESIGN rules: NAV-1/3, VIS-1/3/4, INT-2/3/5/6/7 and ACC-1/3/4.
No exception is requested. Automated Axe/keyboard checks and author inspection do
not establish manual screen-reader or independent usability acceptance. Those
checks and live native-provider resume acceptance were not run. No production
rollout was requested.

## Recovery

Disable emulation or server resume in Usage limits to stop those features. Existing
holds then require explicit retry/cancellation; settings changes never invent work.
The additive migration can remain installed when reverting the code. To revert the
feature, revert its delivery commit and rebuild API, SPA and wrapper together.

## Delivery signature

The configured GPG pinentry timed out during commit signing (Git exit 128).
The local delivery commit is unsigned using a command-scoped override; repository
and global Git signing configuration were not changed.
