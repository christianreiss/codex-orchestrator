# Grok MCP verification — 2026-10-08

## Incident

On biest.eulie.de, native Grok session
`01a11ac3-f373-7123-b5f0-561025ea4c47` reported `tool_output_error` for
`cgx__secret_get` at `2026-10-08T09:07:17Z`.
Its `events.jsonl` records the actual response:
`No secret with slug 'wsdf10.operator-api-biest'`, completed in 33 ms,
without a timeout, reconnect or authentication retry.
The transcript delivered that same error to the model.

The incident-time metadata-only store lookup showed that slug had `engine: codex`.
The pre-fix `SecretsService.getForHost` returned the same not-found error for
an absent, deleted or other-engine credential. Grok's `X-Engine: grok` request
therefore could not read it. This was an engine visibility restriction, not an
invalid MCP result or a broken Grok connection. The model guessed the slug
before calling `secret_search` and `secret_list`.

## Resolution

At the operator's request, engine-scoped access for working secrets is removed.
All callers read the same active credential catalogue. The service, DTOs,
MCP/admin write schemas and dashboard no longer expose a visibility scope.
Legacy `engine` write arguments are rejected rather than silently accepted.
Migration 0044 drops the old column and index, preserving ciphertext and
ownership. `source_engine` and the read audit retain engine attribution only.
Provider login material and host ownership of mutations are unchanged.

No real credential values were retrieved during the audit. Production rollout
has not been performed by this work. Reverting to the pre-migration schema/code
requires restoring the old scope column/index from the pre-rollout backup;
the removed scope cannot be inferred from provenance.

## Coverage and result

| Surface | Coverage | Result |
|---|---|---|
| Server host catalogue | All 78 tools; valid JSON Schema, required arguments, Grok dispatch, successful and failed service responses through JSON-RPC | Pass |
| Optional operator filesystem catalogue | All 6 tools through the same checks, with fake services | Pass |
| Local `cxx-agent` catalogue | All 26 handlers; success and broker failure, JSON serialization, text results; fake broker and owned delivery fixtures | Pass |
| Engine routing | Grok header normalization, enabled/disabled assignments, engine-scoped read identity | Pass |
| Secret access | Codex/Claude/Grok callers can read every legacy scope; real secret decryption and caller-attributed audit against an in-memory DB | Pass |
| MySQL 8.4.11 | 15 secret-store tests and 8 migration-runner tests, including populated legacy scope removal, unchanged ciphertext/provenance and repeated application | Pass |
| Dashboard | 915 frontend tests, Svelte check, production build and targeted Playwright create-without-scope flow | Pass |
| Native Grok 1.0.46-1335998556 | Named `mcp doctor` checks load 84 server tools and 26 local tool definitions from disposable loopback fixtures; protocols 2025-03-26 and 2025-06-18 | Pass |

The scope-removal verification ran **381 focused API tests**, **15 real-MySQL
secret-store tests**, **8 migration-runner tests**, **915 frontend tests** and
one targeted Playwright test, all passing. TypeScript, Svelte, API and frontend
builds passed. Focused ESLint has no errors (one existing unused helper warning
in `mcp-tools.ts`). The earlier compatibility audit also verified Go build/vet
and the agentbus/Grok packages.

The browser test exposed an existing successful-save dialog bug: `onSuccess`
called the dismiss helper while the mutation was still pending, so its guard
kept the dialog open. Successful saves now close directly; user dismissal
remains blocked during a pending write.

The native check exercises discovery and schema decoding, not model-driven
execution of every tool. Service doubles exercise transport/dispatch without
performing production mutations; they do not prove every business workflow or
real-database side effect. Provider inference, production rollout and real peer
delivery were not performed for this audit.

Native `mcp doctor` without a server name also inspects Claude-imported servers,
even with `compat.claude.mcps=false`; the initial broad probe exited 1 because
the imported `browseros-neo` endpoint at `127.0.0.1:9010` refused its connection.
Both requested catalogues were healthy. The repository probe selects each
fixture by name, so that unrelated imported servers are not contacted.

## Reproduction

From `api/`:

```sh
npm test -- test/unit/services/mcp-grok-compatibility.test.ts test/unit/services/secrets.test.ts test/unit/services/mcp-tools.test.ts test/unit/services/mcp-server.test.ts test/integration/mcp test/unit/services/project-tool-schema-closure.test.ts
npm run typecheck
```

From `wrappers/cxx/`:

```sh
go test ./internal/agentbus ./internal/grok
go build ./...
go vet ./...
CXX_MCP_CATALOG_EXPORT=/tmp/cgx-agent-catalog.json go test ./internal/agentbus -run TestMCPCatalogCompatibility -count=1
```

From `api/`, using the installed pinned native binary (no provider credentials):

```sh
npx tsx scripts/check-grok-mcp.ts /absolute/path/to/grok /tmp/cgx-agent-catalog.json
```

The last command creates and removes a disposable Grok config and local HTTP
fixtures. It refuses tool calls. The exported JSON contains tool definitions
only. The tests and diagnostics exercise the shared working-secret model without changing production state.
