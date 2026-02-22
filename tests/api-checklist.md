# API Smoke Checklist (local http://localhost:8488)

All commands assume `API_KEY` is set from a prior successful `/admin/hosts/register` response and that MySQL is seeded by `docker compose up`. Add `-k` for self-signed TLS when testing remote HTTPS.
Admin routes require both a valid admin session cookie and mTLS fingerprint (`X-MTLS-Fingerprint` must be a 64-hex value; `X-mTLS-Present: 1` alone is not accepted).

1) Host provisioning
- Create host + installer → `200 ok` with host payload (including `api_key`) and `installer`: `curl -s -X POST http://localhost:8488/admin/hosts/register -H 'Content-Type: application/json' -H 'X-MTLS-Fingerprint: <64-hex-fingerprint>' -H "Cookie: <admin-session>" -d '{"fqdn":"host.test"}'`
- Installer download works once: `curl -I http://localhost:8488/install/<token>` (expect `200` and `X-Installer-Expires-At` header); reuse should return `410 Installer already used`.

2) Auth retrieve paths
- Missing canonical (fresh DB) → `status=missing` + `action=store`: `curl -s -X POST http://localhost:8488/auth -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d '{"command":"retrieve","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","last_refresh":"2025-11-23T00:00:00Z","client_version":"0.0.0"}'`
- Client newer or diverged at same timestamp → `status=upload_required` (use canonical digest but `last_refresh` one minute ahead of canonical).
- Canonical match → `status=valid`: reuse canonical digest after store (below).
- Client older than canonical → `status=outdated` returns canonical auth.

3) Auth store paths
- Newer or runner-updated auth → `status=updated`: `curl -s -X POST http://localhost:8488/auth -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d @auth.json` (where `auth.json` contains valid `auths` and `last_refresh`).
- Equal timestamp with identical digest → `status=unchanged`.
- Older timestamp (or runner-updated canonical newer) → `status=outdated` returns canonical auth.
- Runner unavailable during store validation → `503 Auth runner unavailable`.

4) API disabled guard
- Set flag: `curl -s -X POST http://localhost:8488/admin/api/state -H 'Content-Type: application/json' -H 'X-MTLS-Fingerprint: <64-hex-fingerprint>' -H "Cookie: <admin-session>" -d '{"disabled":true}'`
- `/auth` now returns `503 API disabled by administrator`.
- While disabled, all routes except `/admin/api/state` return `503` (including `/versions`).
- Re-enable before continuing: `curl -s -X POST http://localhost:8488/admin/api/state -H 'Content-Type: application/json' -H 'X-MTLS-Fingerprint: <64-hex-fingerprint>' -H "Cookie: <admin-session>" -d '{"disabled":false}'`

5) IP binding / roaming (simplified)
- Call `/auth` from a second IP (simulate via `X-Forwarded-For`) → `403` expected_ip in `details`.
- Enable roaming: `curl -s -X POST http://localhost:8488/admin/hosts/1/roaming -H 'X-MTLS-Fingerprint: <64-hex-fingerprint>' -H "Cookie: <admin-session>" -d '{"allow":true}'` then retry `/auth` with new IP → succeeds and updates IP.

6) Wrapper endpoints
- Metadata: `curl -s -H "X-API-Key:$API_KEY" http://localhost:8488/wrapper`
- Download: `curl -I -H "X-API-Key:$API_KEY" http://localhost:8488/wrapper/download` (expect `X-SHA256`).

7) Versions
- Read: `curl -s http://localhost:8488/versions`

8) Usage logging
- Missing fields → `422`: `curl -s -X POST http://localhost:8488/usage -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d '{}'`
- Success (`200`) returns `status=ok` with `data.recorded`, `data.usages`, and aggregate `data.cost`: `curl -s -X POST http://localhost:8488/usage -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d '{"line":"Token usage: total=10 input=6 output=4"}'`
- Ingestion exceptions still return `200` with `data.recorded=false` and `data.reason="usage ingestion failed"`.

9) Admin visibility
- Overview: `curl -s -H 'X-MTLS-Fingerprint: <64-hex-fingerprint>' -H "Cookie: <admin-session>" http://localhost:8488/admin/overview`
- Logs (limit 5): `curl -s -H 'X-MTLS-Fingerprint: <64-hex-fingerprint>' -H "Cookie: <admin-session>" 'http://localhost:8488/admin/logs?limit=5'`
