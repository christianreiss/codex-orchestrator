# Interface Contracts

Machine-readable JSON schemas for host-facing API responses consumed by `cdx`
and `clx`.

Current schemas:
- `auth-retrieve.schema.json` - `POST /auth` retrieve (`command=retrieve` or omitted): `data.status` = `valid|upload_required|outdated|missing`; a failed canonical is `outdated` without an `auth` blob
- `auth-store.schema.json` - `POST /auth` store (`command=store`): `data.status` = `updated|valid|outdated`; every status carries authoritative `auth`
- `versions.schema.json` - `GET /versions`
- `sync-status.schema.json` - `POST /sync/status` (`api/src/services/host-sync.ts` with `bootstrap=false`)
- `sync-bootstrap.schema.json` - `POST /sync/bootstrap` (`api/src/services/host-sync.ts` with `bootstrap=true`), including the guarded candidate-rejection replacement signal

Contract guardrails:
- `api/test/contract/contract.test.ts` replays recorded fixtures through the running Node server and asserts the response shape stays consistent with the captured baseline.
- The same suite compiles every published schema with Ajv in strict JSON Schema 2020-12 mode.
- `api/test/integration/host-api/*` exercises the live host-facing routes (`/auth`, `/sync/status`, `/sync/bootstrap`, `/versions`) on the db-fake, so the checks below run under a plain `npm test` with no database.
- Every schema is checked against a representative live response body via `assertContract` (`api/test/helpers/contract-schema.ts`):
  - `auth-retrieve.schema.json`, `auth-store.schema.json` — `auth-store.test.ts`
  - `sync-bootstrap.schema.json` — `sync-bootstrap.test.ts`
  - `sync-status.schema.json` (`sync-bootstrap.test.ts`) and `versions.schema.json` (`versions.test.ts`) do **not** match what the Node server serves: both still describe the PHP-era payloads. `/sync/status` omits the `agents`/`config` blocks (the port leaves document rendering to `/sync/bootstrap`), and `/versions` omits the settings/runner-telemetry keys (`admin_theme`, `quota_*`, `runner_last_*`, `reported_*`, `client_version_checked_at`, `client_version_source`). No wrapper reads the missing fields. Those two suites pin the divergence against the live body instead of asserting conformance; correcting the schemas turns each pin back into a plain `assertContract` call.
