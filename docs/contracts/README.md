# Interface Contracts

Machine-readable JSON schemas for host-facing API responses consumed by `cdx`.

Current schemas:
- `auth-retrieve.schema.json` - `POST /auth` retrieve (`command=retrieve` or omitted): `data.status` = `valid|upload_required|outdated|missing`
- `auth-store.schema.json` - `POST /auth` store (`command=store`): `data.status` = `updated|unchanged|outdated`
- `versions.schema.json` - `GET /versions`
- `usage-ingest.schema.json` - `POST /usage`
- `sync-status.schema.json` - `POST /sync/status` (`StartupSyncService::collect(..., includeContent=false)`)
- `sync-bootstrap.schema.json` - `POST /sync/bootstrap` (`StartupSyncService::collect(..., includeContent=true)`)

Contract guardrails:
- `tests/ContractSchemasTest.php` (JSON validity + valid/invalid fixture validation for all six schemas)
- `tests/AuthServiceContractResponsesTest.php` (live service response shape checks for `/auth` retrieve/store, `/versions`, `/usage`)
- `tests/StartupSyncRoutesTest.php` (route + wrapper startup-sync wiring checks for `/sync/status` and `/sync/bootstrap`)
- `scripts/verify-interface-contracts.php` (contract file readability + interface-doc drift checks in `docs/interface-api.md`, `docs/interface-cdx.md`, `docs/OVERVIEW.md`)
