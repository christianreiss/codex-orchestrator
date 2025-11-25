# cdx Wrapper Interface (Source of Truth)

- `cdx` is downloaded per host via `/wrapper/download`; the script is baked with `BASE_URL`, `API_KEY`, `FQDN`, and optional CA file.
- On launch it:
  - Pulls `auth.json` from `/auth` (store/retrieve) and refuses to start Codex if sync fails.
  - Autodetects/installs `curl`/`unzip`, updates Codex CLI/binary, and self-updates the wrapper.
  - Parses **all** Codex stdout lines like `Token usage: total=… input=… (+ … cached) output=… (reasoning …)` and POSTs them to `/usage` (as an array) with the host API key; if a line cannot be parsed into numbers, it is still sent as raw `line`.
  - After Codex runs, pushes updated auth if changed and sends token-usage metrics.
- `cdx --uninstall` removes Codex binaries/config, legacy env/auth files, npm `codex-cli`, and calls `DELETE /auth`.
- Wrapper publishing: the bundled `bin/cdx` seeds storage once; subsequent updates should use `POST /wrapper` (with `VERSION_ADMIN_KEY`). Any change to `bin/cdx` must bump `WRAPPER_VERSION`.
