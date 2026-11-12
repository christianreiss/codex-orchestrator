# Native speech input verification (2026-11-12)

Implemented global default on, engine inheritance and native control limitation copy.

- API typecheck passed; 183 targeted tests passed (policy, host rendering, signed config, schema and capability coverage).
- Frontend check passed: 1101 tests, no slop-grep findings; existing unrelated Svelte warnings remain.
- Frontend production build passed.
- Wrapper config tests, go build ./... and go vet ./... passed.
- Playwright speech settings smoke passed. Light 1440px and 390px screenshots captured; 390px visually inspected.
- Fleet Slop quick run 7bd60605-7fe2-44e3-94a3-7fd6e5774af0: zero findings. Source scan only.
- Real microphone capture, dark theme, screen reader and full fleet advisor UI review were not run. No deployment or production change.

Codex central voice switching remains unavailable; Grok controls shortcuts only. Kimi native speech is unsupported. These are displayed limitations, not claimed activation.
