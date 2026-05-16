# Contract suite

This directory contains the **replay** half of the contract test. The
**record** half lives at `tests/contract/record.sh` at the repo root and runs
against the legacy PHP backend.

## Workflow

1. **Record once** (before the PHP backend is deleted):

   ```bash
   docker compose up -d        # bring up the legacy PHP stack
   tests/contract/record.sh    # writes JSON fixtures into tests/contract/fixtures/
   cp -R tests/contract/fixtures/* api/test/contract/fixtures/
   git add api/test/contract/fixtures && git commit -m "test(api): record contract fixtures"
   ```

2. **Replay** as part of CI (or locally) once the Node routes are in place:

   ```bash
   cd api && pnpm test:contract
   ```

   The meta-test walks every `.json` file under `fixtures/` and replays the
   recorded request against the Node app via `inject()`. It asserts:

   - HTTP status code matches.
   - For JSON responses, the top-level *shape* matches (same keys, same JS
     types). Scalar values are deliberately not compared so id/timestamp drift
     between runs doesn't false-positive.
   - The recorded body conforms to the expected envelope shape
     (`standard` / `openai` / `anthropic`).

## Fixture format

```jsonc
{
  "name": "label for readability",
  "expectShape": "standard", // optional; inferred from URL prefix when absent
  "request": {
    "method": "POST",
    "url": "/admin/auth/login",
    "headers": { "content-type": "application/json" },
    "body": { "username": "owner", "password": "..." }
  },
  "response": {
    "status": 200,
    "headers": { "content-type": "application/json; charset=utf-8" },
    "body": { "status": "ok", "data": { /* recorded body */ } }
  }
}
```

## Empty state

When `fixtures/` is empty (the normal state in a fresh checkout) the suite
skips with a clear message; CI passes. Fixtures are committed once on cutover
and only re-recorded when the legacy backend behaviour intentionally changes
during the rewrite.

## Adding to the recorder

Edit `tests/contract/record.sh` to add new endpoints. The script is bash + curl
+ jq, idempotent, and safe to rerun. New endpoints get their own subdirectory
under `tests/contract/fixtures/<route>/`.
