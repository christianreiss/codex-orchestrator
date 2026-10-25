# Authentication presentation — 2026-10-25

The browser sign-in, recovery and CLI approval pages now share branding, a bounded
task surface, header spacing and secondary-action controls through `AuthShell`.
Setup uses the same frame. CLI approval has one primary action; denial remains
available as a neutral secondary action. Session details stack on small screens
and retain long hostnames/IP addresses without page-wide overflow.

Provider credential entry remains in the existing shared `SeedAuthPanel` used by
Accounts, host dialogs and setup. Engine choice stays above both method tabs, with
one consistent heading and spacing for Codex, Claude and Grok. File upload is now a
visible, labeled keyboard-focusable input. Errors remain inline as well as in toast
feedback. Changing engine clears the prior engine's generated command. Provider
ownership instructions, verification outcomes and request endpoints are preserved.

Applicable DESIGN.md rules: NAV-2/3, VIS-1/2/3/4/5, INT-2/3/4/5/7, ACC-1/3/4/5.
No exception is requested. Authentication/authorization/TLS have not been weakened.

## Checks

- Node 22 frontend `npm run check`: zero Svelte errors/warnings, **999 unit tests
  passed**. The brand regression now checks branding in the shared frame and
  prevents duplicate branding in its three authentication page consumers.
- Focused Playwright run: **32 passed**. Sign-in, reset and CLI pages exercised in
  light/dark/system at widths 320, 390, 768, 1440 and 1920; all three provider panels
  exercised at desktop/light and 320px/dark. Tests include Axe assertions, retained
  provider management behavior, keyboard file selection, method-switch command
  ownership, and long CLI host identity with keyboard approval controls.
- Canonical full frontend `npm run test:e2e -- --workers=2`: **353 passed** in
  18.0 minutes, including the full route/state/design sweep in both themes. The
  suite rebuilt the SPA and used an isolated preview with deterministic API fixtures;
  no real credentials or provider grants were used. All 212 build files match the
  deployable `public/admin` copy byte for byte; entrypoint asset references exist.
- Representative Chromium captures were visually inspected. Screenshot evidence is
  retained outside source in `/var/tmp/rosa-login-ui-evidence` after verification.

## Scope and remaining manual acceptance

This is presentation and local feedback handling, with no backend or wrapper source
change. API/Go suites are not rerun. External provider-owned login pages cannot be
restyled by this product; the three in-product connection surfaces are unified.

The viewport matrix proves reflow in the fixture states, not every setup step or
real provider account. Screen-reader tasks, physical mobile keyboard, manual 400%
browser zoom/200% text resizing, cross-browser checks and independent operator
usability review remain unperformed. No field Web Vitals measurement is claimed.

## Live rollout on docker01

Source `55d0e0e0fe6ea6b2c6bbd043a092a25ef9978ed9` was pushed and deployed with
`scripts/deploy.sh --no-backup --skip-wrappers --no-cleanup`. Actual API image:
`sha256:22a2f95bbb58af201e873f947b88ca911d5dee05da9157e6fd920307def7052e`.
API health passed, restarts zero; 104 migrations applied, zero pending/drifted.
The baked UI and actual HTTP HTML response match the checked-in artifact byte for
byte. Real anonymous sign-in browser checks passed at 390px/light and 1440px/dark;
no credentials were entered. Captures are `live-login-light-390.png` and
`live-login-dark-1440.png` in the evidence directory.

The normal owner cutover recreated the API and restarted the media worker; native
sessions and wrapper binaries were preserved. No DB/storage backup was created.
Verified temporary cutover metadata and its two rollback tags were removed under
the operator's cleanup instruction, recorded in the existing cleanup receipt.
Prior source/UI can be rebuilt from `65ecbdb7f2740c680b6e3e0406ca320f88b2c570`.

## Concurrent Grok recovery follow-up

The operator reported repeated `cgx login` and a normal-start503
`grok_refresh_uncertain`. Before the latest login, the server had only account7
payload766/generation88 from11:17UTC, uncertain since17:12UTC. The new login was
accepted at20:26:22UTC as payload771/generation89, verified/idle, expiry02:26UTC
the next day. No old refresh token was replayed or state forcibly cleared.

Sigrid verified a fresh normal managed Grok inference on biest: loaded cxx0.9.133,
Grok1.0.50, exact nonce `grok-auth-20261025-2026-ok`, one turn/model call, exit0 in
19seconds. Native session `01a174bf-c530-7191-8f7e-0f84afefc2d3`. This verifies the
new login end to end; it does not repair/replay the older Natascha accepted work.
Existing loaded communicator0.9.127 and daemon0.9.128 remain undisturbed. The
`/auth/sessions`503 originates in normal run, not the dedicated login/upload path.
Earlier renewal attempts cannot be individually attributed without CLI outcome
evidence. Feedback `ca015ff1-a020-491d-b85b-62bcd492725e` is now resolved.
