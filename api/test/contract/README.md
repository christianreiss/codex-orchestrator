# Contract suite

Forward-looking shape-assertion runner. Walks every `.json` file under
`fixtures/`, replays the recorded request against the Node app via
`inject()`, and asserts:

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
cd api && pnpm test:contract
```

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

When `fixtures/` is empty the suite skips with a clear message and CI passes.
Add fixtures under `fixtures/<route>/` named after the endpoint they exercise.
