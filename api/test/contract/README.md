# Contract suite

Shape-assertion runner. Walks every `.json` file under `fixtures/`, replays the
recorded request against the host-api app built on the db-fake (no MySQL
needed) via `inject()`, and asserts:

- HTTP status code matches.
- The replayed JSON body satisfies the fixture’s envelope rules, including the
  `raw` host response format.
- Object keys and value types match recursively. When a recorded array has a
  sample item, each returned item is checked against its shape. Scalar values
  can vary between runs.
- The replayed body passes the fixture’s published JSON Schema.

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

See the [auth retrieve fixture](fixtures/auth/retrieve.json) for a complete
request, the test credential, the `expectShape` setting and both copies of the
response fields. The fixture records the full key set at each nesting level.

The host-facing routes replace the standard envelope's `status: "ok"` marker
with a domain status (`valid`, `outdated`, `updated`, `update`), so their
fixtures record `"expectShape": "raw"` — the recorded body still carries both
the root fields and the legacy `data` mirror, so envelope drift is caught by
the shape check.

## Current coverage

Every row is pinned by `contract.test.ts`: the `Published schema` column must
name exactly the `*.schema.json` files under `docs/contracts/`, and the
fixture→schema pairing must match the one the suite validates with.

| Fixture | Endpoint | Published schema |
| --- | --- | --- |
| `auth/retrieve.json` | `POST /auth` (`command=retrieve`) | `auth-retrieve.schema.json` |
| `auth/store.json` | `POST /auth` (`command=store`) | `auth-store.schema.json` |
| `sync/status.json` | `POST /sync/status` | `sync-status.schema.json` |
| `sync/bootstrap.json` | `POST /sync/bootstrap` | `sync-bootstrap.schema.json` |
| `versions/snapshot.json` | `GET /versions` | `versions.schema.json` |
