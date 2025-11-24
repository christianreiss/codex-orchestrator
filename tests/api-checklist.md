# API Smoke Checklist (local http://localhost:8488)

All commands assume `API_KEY` is set from a prior successful `/admin/hosts/register` response and that MySQL is seeded by `docker compose up`. Add `-k` for self-signed TLS when testing remote HTTPS.

1) Host provisioning
- Create host + installer → `200 ok` with `api_key` and `installer`: `curl -s -X POST http://localhost:8488/admin/hosts/register -H 'Content-Type: application/json' -H 'X-mTLS-Present: 1' -d '{"fqdn":"host.test"}'`
- Installer download works once: `curl -I http://localhost:8488/install/<token>` (expect `200` and `X-Installer-Expires-At` header); reuse should return `410 Installer already used`.

2) Auth retrieve paths
- Missing canonical (fresh DB) → `status=missing`: `curl -s -X POST http://localhost:8488/auth -H "X-API-Key:$API_KEY" -H 'Content-Type: application/json' -d '{"command":"retrieve","digest":"aa...","last_refresh":"2025-11-23T00:00:00Z","client_version":"0.0.0"}'`
- Client newer than canonical → `status=upload_required`: use canonical digest but `last_refresh` one minute ahead of canonical.
- Canonical match → `status=valid`: reuse canonical digest after store (below).
- Digest mismatch when server newer → `status=outdated` returns canonical auth.

3) Auth store paths
- Updated (newer last_refresh) → `status=updated`: `curl -s -X POST http://localhost:8488/auth -H "X-API-Key:$API_KEY" -H 'Content-Type: application/json' -d @auth.json` (where `auth.json` contains valid `auths` and `last_refresh`).
- Equal timestamp → `status=unchanged` (repeat previous store body).
- Older timestamp → `status=outdated` returns canonical auth.

4) API disabled guard
- Set flag: `curl -s -X POST http://localhost:8488/admin/api/state -H 'Content-Type: application/json' -H 'X-mTLS-Present: 1' -d '{"disabled":true}'`
- `/auth` now returns `503 API disabled by administrator`.

5) IP binding / roaming
- Call `/auth` from a second IP (simulate via `X-Forwarded-For`) → `403` expected_ip in `details`.
- Enable roaming: `curl -s -X POST http://localhost:8488/admin/hosts/1/roaming -H 'X-mTLS-Present: 1' -d '{"allow":true}'` then retry `/auth` with new IP → succeeds and updates IP.

6) Wrapper endpoints
- Metadata: `curl -s -H "X-API-Key:$API_KEY" http://localhost:8488/wrapper`
- Download: `curl -I -H "X-API-Key:$API_KEY" http://localhost:8488/wrapper/download` (expect `X-SHA256`).
- Admin upload failure: missing file → `422`: `curl -s -X POST http://localhost:8488/wrapper -H 'X-Admin-Key: bad'`

7) Versions
- Publish: `curl -s -X POST http://localhost:8488/versions -H 'Content-Type: application/json' -H 'X-Admin-Key: ${VERSION_ADMIN_KEY}' -d '{"client_version":"v1.2.3","wrapper_version":"2025.11.22-6"}'`
- Read: `curl -s http://localhost:8488/versions`

8) Usage logging
- Missing fields → `422`: `curl -s -X POST http://localhost:8488/usage -H "X-API-Key:$API_KEY" -H 'Content-Type: application/json' -d '{}'`
- Success: `curl -s -X POST http://localhost:8488/usage -H "X-API-Key:$API_KEY" -H 'Content-Type: application/json' -d '{"line":"Token usage: total=10 input=6 output=4"}'`

9) Admin visibility
- Overview: `curl -s -H 'X-mTLS-Present: 1' http://localhost:8488/admin/overview`
- Logs (limit 5): `curl -s -H 'X-mTLS-Present: 1' 'http://localhost:8488/admin/logs?limit=5'`
