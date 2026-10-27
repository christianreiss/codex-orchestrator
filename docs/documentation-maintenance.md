# Keeping documentation aligned with code

Use [the documentation index](README.md) to find current guides and contracts.
Dated reviews describe evidence at their recorded revision; they do not establish
current deployment state. Keep historical reports intact when correcting current
operator instructions.

## Sources and destinations

| Behavior | Verify in source | Keep aligned |
| --- | --- | --- |
| HTTP routes, auth and capabilities | `api/src/routes/`, `api/src/security/route-capabilities.ts`, `api/src/security/capabilities.ts` | `API.md`, `interface-api.md`, `ADMIN.md`, `LOGIN.md` |
| Tables, columns and settings | `api/src/db/schema.ts`, migrations, `api/src/env.ts` | `interface-db.md`, `INSTALL.md`, `SECURITY.md` |
| MCP tools and resources | `api/src/services/mcp-tools.ts`, MCP route handlers and service schemas | `MCP.md`, relevant interface and feature guides |
| Server ownership and background work | `api/src/server.ts`, `api/src/control-plane/`, `api/src/ops/` | `OVERVIEW.md`, `control-plane-owner.md`, `owner-cutover.md`, `api/README.md` |
| Host lifecycle and commands | `wrappers/cxx/`, `wrappers/Makefile`, host config schemas | `interface-cdx.md`, `interface-clx.md`, `interface-cgx.md`, `wrappers/README.md` |
| Installation and delivery | `bin/install.sh`, `bin/orchestrator`, `scripts/deploy.sh`, `docker-compose.yml` | `INSTALL.md`, rollout and recovery guides |
| Console navigation and behavior | `frontend/src/lib/nav.ts`, route layouts and page components | `ADMIN.md`, `public/admin/manual/articles/`, `DESIGN.md` inventory |
| Android companion | `mobile/android/`, companion API handlers | `android-companion.md`, Account help |
| Auth runner | `runner/app.py`, `runner/Dockerfile` | `runner/README.md`, `auth-runner.md` |

Read [the web design standard](../DESIGN.md) before reviewing browser UI. Follow
the actual route registry for labels and destinations; retired URLs may still
redirect and therefore do not prove a page is the current owner. Distinguish
stored usage display, quota enforcement, and automatic account selection.

For concurrent work, compare a recorded committed revision in an isolated
worktree. Exclude another worker's uncommitted implementation from claims about
shipped behavior. Before integration, recheck any source files that advanced.

## Existing verification

The API suite includes documentation checks for registered HTTP routes, MCP
methods/tools/templates, database tables and columns, environment variables,
capability matrices, manual source references and frontend API paths. From an
installed Node 22 development environment:

```sh
cd api
npm ci --no-audit --no-fund
npm test
```

This is the canonical database-free test tier. Real-MySQL tests are collected
but skip unless enabled; see [API test setup](../api/README.md#tests-and-coverage)
for the separate disposable-database and coverage gates. A documentation check
can prove a route or field exists without proving every sentence about its
semantics: inspect the implementation and nearby behavior tests as well.

For a narrow edit, Vitest accepts individual files or name fragments, for example:

```sh
npm test -- test/unit/ops/docs-install-env-truth.test.ts
npm test -- test/unit/routes/manual-source-references.test.ts
```

When the capability matrix changes, regenerate its existing marked section with
`npm run docs:capabilities`, then inspect the diff. Do not hand-edit a generated
matrix to silence a failure.

Runner documentation has executable surface, environment and image checks. With
the runner's test dependencies installed, run from `runner/`:

```sh
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest -q \
  test_docs_surface.py test_docs_env.py test_dockerfile_claims.py
```

The isolated pytest invocation avoids unrelated globally installed plugins.
Run `git diff --check` and verify new relative document links before committing.
Manual Markdown lives in `public/admin/manual/articles/`; changing only those
articles does not require rebuilding the Svelte SPA. Frontend source changes do
require the frontend checks/build described in the repository instructions.

Report the revision checked, the checks actually run and their limits. Source
and documentation tests do not prove an installation, production migration,
provider request, device install or interactive accessibility acceptance.
