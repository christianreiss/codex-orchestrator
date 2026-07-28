# Contract suite

Shape-assertion runner. Walks every `.json` file under `fixtures/`, replays the
recorded request against the host-api app built on the db-fake (no MySQL
needed) via `inject()`, and asserts:

- HTTP status code matches.
- For JSON responses, the top-level *shape* matches (same keys, same JS
  types). Scalar values are deliberately not compared so id/timestamp drift
  between runs doesn't false-positive.
- The recorded body conforms to the expected envelope shape
  (`standard` / `openai` / `anthropic`).

Fixtures are hand-authored and checked in alongside the API change that
introduces or changes the endpoint they cover. There is no automated
recorder — when the contract evolves, edit the relevant fixture in the same
commit as the route change.

## Running

```bash
cd api && npm run test:contract
```

## Seeded world

Every fixture replays against the same state, seeded by `seedContractWorld()`
in `contract.test.ts`: one active dual-engine host `contract.example` holding
the API key `sk-contract-fixture`, a published version snapshot, and a verified
Codex canonical auth payload newer than the host's (absent) local copy. A
fixture request therefore only needs `Authorization: Bearer sk-contract-fixture`.

## Fixture format

```jsonc
{
  "name": "label for readability",
  "expectShape": "standard", // optional; inferred from URL prefix when absent
  "request": {
    "method": "POST",
    "url": "/auth",
    "headers": { "content-type": "application/json" },
    "body": { "command": "retrieve", "engine": "codex" }
  },
  "response": {
    "status": 200,
    "headers": { "content-type": "application/json; charset=utf-8" },
    "body": { "status": "ok", "data": { /* recorded body */ } }
  }
}
```

The host-facing routes replace the standard envelope's `status: "ok"` marker
with a domain status (`valid`, `outdated`, `updated`, `update`), so their
fixtures record `"expectShape": "raw"` — the recorded body still carries both
the root fields and the legacy `data` mirror, so envelope drift is caught by
the shape check.

## Current coverage

| Fixture | Endpoint | Published schema |
| --- | --- | --- |
| `auth/retrieve.json` | `POST /auth` (`command=retrieve`) | `auth-retrieve.schema.json` |
| `auth/store.json` | `POST /auth` (`command=store`) | `auth-store.schema.json` |
| `sync/status.json` | `POST /sync/status` | `sync-status.schema.json` |
| `sync/bootstrap.json` | `POST /sync/bootstrap` | `sync-bootstrap.schema.json` |
| `versions/snapshot.json` | `GET /versions` | `versions.schema.json` |
