# cdx Wrapper Interface (Source of Truth)

- `cdx` is downloaded per host via `/wrapper/download`; the script is baked with `BASE_URL`, `API_KEY`, `FQDN`, optional CA file, and the host security flag (`secure`, defaults to on). Insecure hosts start with a 30-minute provisioning window so initial sync works immediately; admins can later enable/disable windows from the dashboard.
- Source is organized under `bin/cdx.d/*.sh`; run `scripts/build-cdx.sh` to assemble the shipped `bin/cdx`. Edit fragments, not the built file, and bump `WRAPPER_VERSION` whenever `bin/cdx` changes.
- On launch it:
  - Pulls `auth.json` from `/auth` (store/retrieve); if the API is unreachable it now proceeds with the cached `auth.json` when present and fresher than 24 hours, but still refuses to start when the key is invalid or no fresh auth is available.
  - Reports the current user + hostname to `/host/users` (API key + IP binding) and receives the known user list for the host; `--uninstall` removes `~/.codex` for those users (fallback: current user only if the API call fails).
  - Honors the server-side ChatGPT quota policy (`quota_hard_fail`); default is deny-on-quota, but admins can flip to warn-only in the dashboard (or set `CODEX_QUOTA_HARD_FAIL=0` before running `cdx`).
- Synchronizes slash command prompts in `~/.codex/prompts` against `/slash-commands` (lists + per-file retrieve on hash mismatch) and records a baseline; on exit it pushes any changed/new prompts back via `/slash-commands/store`. Server-retired prompts are removed locally.
  - Autodetects/installs `curl`/`unzip`, updates Codex CLI/binary, and self-updates the wrapper.
  - Parses **all** Codex stdout lines like `Token usage: total=… input=… (+ … cached) output=… (reasoning …)` and POSTs them to `/usage` (as an array) with the host API key; if a line cannot be parsed into numbers, it is still sent as raw `line`.
  - When `/auth` returns a `chatgpt_usage` block, surfaces 5-hour and weekly ChatGPT quota bars during boot (with reset ETA) for operator visibility.
  - After Codex runs, pushes updated auth if changed and sends token-usage metrics. When the host is marked **insecure** (API `host.secure=false` or baked flag), `cdx` purges `~/.codex/auth.json` after the push so credentials are not left on disk and emits an extra bootstrap warning line to flag the ephemeral state. Insecure hosts now require an admin toggle: API access is denied by default, the dashboard “Enable” button opens a 10-minute sliding window for `/auth` (each call extends it), “Disable” closes it immediately but leaves a 60-minute store-only grace so the host can finish pushing changes.
- `cdx --uninstall` removes Codex binaries/config, legacy env/auth files, npm `codex-cli`, and calls `DELETE /auth`.
- `cdx --update` forces a wrapper refresh from the server (via `/wrapper/download`) even when versions match, then exits after the update attempt.
- The API can return HTTP 429 when IP rate limits trip (global bucket or repeated invalid API keys). Responses include `bucket`, `limit`, and `reset_at`; callers should back off until `reset_at` before retrying.
- Wrapper publishing: the bundled `bin/cdx` in the Docker image is the source of truth. Rebuilds seed storage automatically; there is no `/wrapper` upload endpoint. Any change to `bin/cdx` must bump `WRAPPER_VERSION`.
