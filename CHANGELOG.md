# 2025-12-01
- Fixed installation UUID bootstrap to reuse existing `.env` values and avoid chmods that broke web-user access, preventing API 500s when env files were unreadable.
- Added installation UUID enforcement (server + baked cdx) to prevent cross-instance mixups; `/auth` rejects mismatched `installation_id`, installers/cdx carry the UUID.
- Added persistent IPv4-only host toggle (admin API + dashboard) that clears IP binding and bakes wrappers/installers with `curl -4`; cdx fetches updates over IPv4 when set.
- Aligned Logs header button styling with other admin controls.
- Installation UUID now auto-generates at boot/migration via shared helper, ensuring `.env` is populated across entrypoints without manual edits.
- Dashboard now shows weekly and month-to-date cost estimates side-by-side (using pricing + token usage) instead of daily totals.
- ChatGPT usage cost card now renders separate lines: “X$ this Week” and “Y$ this Month” for clearer readability.
