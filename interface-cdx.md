# cdx Wrapper Interface (Source of Truth)

- `cdx` is downloaded per host via `/wrapper/download`; the script is baked with `BASE_URL`, `API_KEY`, `FQDN`, and optional CA file.
- On launch it:
  - Pulls `auth.json` from `/auth` (store/retrieve); if the API is unreachable it now proceeds with the cached `auth.json` when present, but still refuses to start when the key is invalid or no auth is available.
  - Autodetects/installs `curl`/`unzip`, updates Codex CLI/binary, and self-updates the wrapper.
  - Parses **all** Codex stdout lines like `Token usage: total=… input=… (+ … cached) output=… (reasoning …)` and POSTs them to `/usage` (as an array) with the host API key; if a line cannot be parsed into numbers, it is still sent as raw `line`.
  - When `/auth` returns a `chatgpt_usage` block, surfaces 5-hour and weekly ChatGPT quota bars during boot (with reset ETA) for operator visibility.
  - After Codex runs, pushes updated auth if changed and sends token-usage metrics.
- `cdx --uninstall` removes Codex binaries/config, legacy env/auth files, npm `codex-cli`, and calls `DELETE /auth`.
- Wrapper publishing: the bundled `bin/cdx` in the Docker image is the source of truth. Rebuilds seed storage automatically; there is no `/wrapper` upload endpoint. Any change to `bin/cdx` must bump `WRAPPER_VERSION`.
