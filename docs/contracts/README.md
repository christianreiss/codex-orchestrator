# Interface Contracts

Machine-readable JSON schemas for host-facing API responses consumed by `cdx`.

Current schemas:
- `auth-retrieve.schema.json` - `POST /auth` retrieve (`command=retrieve` or omitted): `data.status` = `valid|upload_required|outdated|missing`
- `auth-store.schema.json` - `POST /auth` store (`command=store`): `data.status` = `updated|unchanged|outdated`
- `versions.schema.json` - `GET /versions`
- `usage-ingest.schema.json` - `POST /usage`
- `sync-status.schema.json` - `POST /sync/status` (`api/src/services/host-sync.ts` with `bootstrap=false`)
- `sync-bootstrap.schema.json` - `POST /sync/bootstrap` (`api/src/services/host-sync.ts` with `bootstrap=true`)

Contract guardrails:
- `api/test/contract/contract.test.ts` replays recorded fixtures through the running Node server and asserts the response shape stays consistent with the captured baseline.
- `api/test/integration/host-api/*` exercises the live host-facing routes (`/auth`, `/usage`, `/sync/status`, `/sync/bootstrap`, `/versions`) against a real database.
