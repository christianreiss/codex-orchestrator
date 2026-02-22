# Interface Contracts

Machine-readable contracts for high-risk API responses consumed directly by `cdx` and dashboards.

Current schemas:
- `auth-retrieve.schema.json` - `POST /auth` retrieve (`valid|upload_required|outdated|missing`)
- `auth-store.schema.json` - `POST /auth` store (`updated|unchanged|outdated`)
- `versions.schema.json` - `GET /versions`
- `usage-ingest.schema.json` - `POST /usage`
- `sync-status.schema.json` - `POST /sync/status` (startup diff summary)
- `sync-bootstrap.schema.json` - `POST /sync/bootstrap` (startup bundled payload)

Validation and sync checks are enforced by:
- `tests/ContractSchemasTest.php` (fixture + schema validation)
- `tests/AuthServiceContractResponsesTest.php` (live service response shapes)
- `scripts/verify-interface-contracts.php` (schema/docs drift guard)
