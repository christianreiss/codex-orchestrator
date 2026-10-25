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

The deployable `public/admin` artifact is rebuilt with the source. Production rollout
and live browser acceptance are separate from the isolated preview checks.
