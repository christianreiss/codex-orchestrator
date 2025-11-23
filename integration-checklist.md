# Integration Checklist (2025-11-23)
Interface snapshots (`interface-db.md`, `interface-api.md`, `interface-cdx.md`) now live in the repo (added 2025-11-23) and reflect current code; this checklist highlights remaining deltas between code, wrapper scripts, and older docs (`README.md`, `API.md`, `AGENTS.md`).

| Flow / Endpoint | CDX expects | API actually does | DB schema supports? | Status |
| --- | --- | --- | --- | --- |
| Auth retrieve → store decision | Returns `upload_required` when client `last_refresh` is newer so cdx uploads; otherwise `outdated` only when server newer (docs). | `handleAuth` now emits `upload_required` when client `last_refresh` is newer; otherwise `valid`/`outdated`/`missing` (`src/Services/AuthService.php:146-211`). | Canonical payload + digests stored in `auth_payloads`/`host_auth_digests`/`host_auth_states` (`src/Database.php:78-170`). | OK |
| Auth store payload validation | cdx sends store only after `missing/upload_required` and accepts tokens-only auth by synthesizing `auths` from `tokens.access_token`/`OPENAI_API_KEY` (`bin/cdx:820-855`). | API synthesizes `auths` from `tokens.access_token` or `OPENAI_API_KEY` when missing, while still enforcing token quality (`src/Services/AuthService.php:606-668`). | `auth_entries.token` is `TEXT NOT NULL`; no DB constraint on entropy. | OK |
| Register/IP binding & uninstall | codex-uninstall assumes `DELETE /auth` will deregister with stored API key (`bin/codex-uninstall:224-260`). | API binds API key to first IP; `DELETE /auth` enforces IP unless `force=1`/`X-CodeX-Self-Destruct` set (uninstaller already uses `force=1`) (`public/index.php:256-262`, `bin/codex-uninstall:214-259`). | `hosts.ip`, `allow_roaming_ips` columns present (`src/Database.php:57-72`). | OK |
| client_version field | Docs now mark it optional and default to `unknown` (API.md); cdx always sends a value (`bin/cdx:576-584`). | API treats it optional; defaults to `unknown` and still processes (`src/Services/AuthService.php:132-155`). | `hosts.client_version` nullable (`src/Database.php:64-68`). | OK |
| /versions caching | Docs and code both use 3h GitHub cache; wrapper/client version chosen as max of stored/published/reported (`src/Services/AuthService.php:21-24`, `README.md`). | Same as docs. | `versions` table simple KV (`src/Database.php:173-181`). | OK |
| Wrapper metadata in /auth | cdx reads `wrapper_version/url/sha` to decide self-update (`bin/cdx:611-619`). | API returns the highest wrapper among stored/published/reported; docs updated to match (`API.md`, `README.md`). | Wrapper file path + versions table exist (`src/Services/WrapperService.php:19-72`). | OK |
| /usage reporting | cdx parses “Token usage” line and posts totals (`bin/cdx:887-1020`). | API stores token counts, returns echoed data (`public/index.php:243-253`, `src/Services/AuthService.php:329-376`). | `token_usages` table records host_id/totals (`src/Database.php:139-155`). | OK |
| Interface docs | Expect interface-* markdown to drive audits. | `interface-api.md`, `interface-db.md`, `interface-cdx.md` present and aligned to code as of 2025-11-23. | — | OK |

## Hard Mismatches
None.

## Soft Mismatches
- TLS strictness: `cdx` falls back to an unverified SSL context if both custom CA and system trust fail; not reflected in server-side docs.

## Recommended Changes
1) [Security] Make the unverified TLS fallback in `cdx` opt-in (flag/env), to avoid silent trust of invalid certs.  
2) [Test] Add an automated smoke test that exercises the `upload_required` path (client newer than canonical) to guard the retrieve/store handshake.  
3) [Doc upkeep] Keep interface docs (`interface-api.md`, `interface-db.md`, `interface-cdx.md`) as primary contracts; ensure future README/API snippets reference them.

## Smoke Test Script (manual)
- `BASE=http://localhost:8488`; `INVITE=<key>`; `HOST=test.local`.
- Register: `API_KEY=$(curl -sf -H 'Content-Type: application/json' -d '{"fqdn":"'"$HOST"'","invitation_key":"'"$INVITE"'"}' "$BASE/register" | jq -r '.host.api_key // .data.host.api_key')`.
- Seed canonical: `TOKEN=$(openssl rand -hex 20)`; `curl -sf -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d '{"command":"store","client_version":"0.0.0","auth":{"last_refresh":"2025-11-23T12:00:00Z","auths":{"api.openai.com":{"token":"'"$TOKEN"'"}}}}' "$BASE/auth"`.
- Verify retrieve paths: `curl -sf -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d '{"command":"retrieve","last_refresh":"2025-11-23T12:05:00Z","digest":"000...000","client_version":"0.0.0"}' "$BASE/auth"`.
- Usage sample: `curl -sf -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d '{"line":"Token usage: total=10 input=6 output=4"}' "$BASE/usage"`.
- Cleanup (bypass IP if needed): `curl -sf -X DELETE -H "X-API-Key: $API_KEY" "$BASE/auth?force=1"`.
