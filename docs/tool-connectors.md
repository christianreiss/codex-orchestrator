# Tool connectors (proposal)

**Status:** proposal, not implemented. Written 2026-11-26 against `main` at
`3b1f8bcdb`. Nothing in this document describes current behavior.

**Name clash:** these are *outbound* connectors. The fleet calls third-party
services through them. They are unrelated to the *inbound* OAuth chat connectors
in [connectors.md](connectors.md), where the orchestrator is the MCP server for
hosted ChatGPT and Claude. Implementation should pick a prefix that keeps the two
apart, for example `tool_connector_*` tables and `connector_*` MCP tools.

## Problem

Agents increasingly need MCP servers and HTTP APIs that the orchestrator does not
own: third-party SaaS, company services and self-hosted tools. Today an agent that
needs one either relies on a native MCP entry that happened to be configured
before its session started, or writes a one-off client script and throws it away.

Observed patterns (one operator installation, 2026-11-26):

- **Hand-rolled clients.** Transcripts contain agent-written JSON-RPC clients
  (initialize, `tools/list`, `tools/call`) for remote and loopback MCP servers.
  Some of this is development of those servers themselves, but scripts that only
  consume a service also occur. One example read the bearer token from an `.env`
  file through stdin and built its own TLS context.
- **Secrets plus prose.** The fleet secret store holds many MCP bearer tokens. Each
  description explains in prose how to register the server natively or inject the
  token. Usually a fleet Skill exists per service as well.
- **Skills full of plumbing.** A billing-service Skill spends about 40 % of its
  text on transport details:
  - a Codex `--profile` workaround, needed because the managed base
    `config.toml` is regenerated
  - restart instructions
  - `Accept`, session-ID and SSE handling
  - a Python-only TLS flag

  For running sessions it tells agents to write a direct JSON-RPC client. It
  documents a setup only for Codex hosts.
- **Non-standard access paths.** One internal service accepts MCP calls only with
  short-lived delegation tokens from a company gateway. That gateway admits only
  the hosted ChatGPT and Claude connector surfaces. The same service also offers a
  read-only REST integration API with a personal bearer token. A generic MCP
  client cannot use that API; a small script can.

Native per-engine MCP configuration already exists. The wrapper renders managed
entries into `~/.claude.json`, Codex and Grok `config.toml`, and Kimi `mcp.json`.
That path still leaves four gaps:

- servers load only at session start
- credentials would sit in plain-text config
- every tool occupies context permanently
- non-MCP APIs are not covered at all

## Goals

- Write a connector once and let every agent on every host and engine call it,
  including mid-session and without a restart.
- Keep credentials in the fleet secret store. Agents never receive them.
- Cover MCP servers through declarative proxying, and anything else through a
  small sandboxed script.
- Reach services that only accept traffic from a known network (from docker01)
  and loopback-only services (through the owning host).
- Keep third-party output and tool descriptions untrusted, auditable and bounded.

## Non-goals (first iteration)

- Arbitrary code execution for agents. Connector code is operator-approved;
  agents propose it.
- Running third-party stdio MCP packages (`npx`, `uvx`, containers).
- Getting through gateways that deliberately exclude fleet clients. Those need a
  fleet client registered by the gateway's owner first.

## Model

A connector is a versioned manifest plus an implementation.

```yaml
slug: billing
title: Billing service
kind: mcp-proxy            # mcp-proxy | script
egress: server             # server (docker01) | host:<host_id> (communicator relay)
endpoint:
  url: https://billing.example.org/mcp
  transport: streamable_http
  tls:
    ca_secret: null        # optional private CA bundle from the secret store
    client_identity_secret: null   # optional mTLS identity (PEM chain + key)
auth:
  type: bearer             # none | bearer | header | oauth | basic
  secret: billing.mcp-token   # placeholder slug
acts_as: operator          # whose identity upstream sees; shown to every caller
allow:
  hosts: all               # or explicit host ids
  engines: [codex, claude, grok, kimi]
tools: discovered          # mcp-proxy: upstream tools/list, pinned at approval
limits:
  timeout_seconds: 30
  max_result_bytes: 131072
  rate_per_minute: 60
```

For `kind: script`, the manifest declares its tools explicitly, as name,
description, input schema and annotations. The implementation is one TypeScript
module:

```ts
// Placeholder service and secret slug.
export const tools = {
  async get_status_today(_args, ctx) {
    const res = await ctx.fetch('https://status.example.org/api/v1/today', {
      headers: { authorization: `Bearer ${ctx.secret('status.integration-token')}` },
    });
    return ctx.json(res);   // status-checked, size-capped, marked untrusted
  },
};
```

### Kinds

- **`mcp-proxy`:** no code. The orchestrator speaks MCP to the upstream server:
  - every published transport revision
  - session IDs, SSE responses and `tools/list` pagination
  - auth and TLS taken from the manifest

  This covers most bearer-, header- or mTLS-protected remote MCP servers.
- **`script`:** a small module for REST APIs, odd auth flows, response shaping or
  combining several calls. It is the only kind that runs code.

### Egress

- **`server`:** the call leaves from the orchestrator stack on docker01. This is
  the default, and the right one for services that allow-list a source network:
  one egress address is far easier to admit than every host.
- **`host:<id>`:** the call is relayed through that host's communicator. Use it
  for loopback-only services such as a tracker bound to `127.0.0.1`. In the first
  iteration this is limited to `mcp-proxy`, so hosts never run connector scripts.
  Which existing communicator channel can carry the relay is an open question.

## Agent surface

**Fleet MCP tools**, present in every session on every engine. They work
immediately after a connector is activated, without restarting anything:

| Tool | Purpose |
| --- | --- |
| `connector_list` | Active connectors visible to this host, with `acts_as` and health |
| `connector_search` | Tools matching a query, name and one-line description only |
| `connector_schema` | Full input schema and annotations for one tool |
| `connector_call` | Call `{connector, tool, arguments, request_id}` |

Schemas load lazily, so a session does not pay context for every upstream tool.

**Native tools (optional pin):** an operator can pin a connector. Its tools then
also appear as first-class fleet MCP tools (`conn_<slug>__<tool>`) from the next
session on. Use this for the few services agents call constantly.

**CLI:** `cxx connector list|search|schema|call` gives the same operations to
scripts and to engines without MCP access.

**Skills:** the plumbing in Skills is replaced by a dependency declaration, for
example `connectors: [billing]` in the frontmatter. The body keeps only the
domain rules, such as per-mutation approval, `web_url` linking and
confidentiality. Fleet tooling can then report "Skill billing needs connector
billing: active / not approved / upstream failing".

## Execution and isolation

- **Connector runner.** A dedicated container beside the API, following the
  auth-runner pattern (`AUTH_RUNNER_URL`). The API authenticates the caller,
  checks policy and forwards a single call. The runner executes it and returns a
  bounded result.
- **Script sandbox.** Each call runs in a fresh, permission-restricted runtime:
  - network only to the manifest's declared hosts; no filesystem, environment or
    subprocesses
  - CPU-time, wall-clock and memory limits
  - no redirects carrying credentials to another origin

  Candidates: Deno with per-call `--allow-net=<hosts>`, workerd, or an isolate
  library. This is an open decision, see below.
- **Secrets.** Bound by slug and resolved inside the runner, per call. They are
  never part of a tool result, an error, an audit record or a log line. Agents no
  longer need `secret_get` for these services, which shrinks the number of places
  a token can leak.
- **Results.**
  - size-capped; larger payloads go to the transfer pool and return a transfer id
  - wrapped as untrusted data
  - upstream error text is passed through only after credential scrubbing

## Governance

- **Lifecycle.** An agent proposes a connector or a new version (`connector_put`).
  `connector_test` then runs the declared tools in a dry run against the real
  upstream with the bound secret. Activation requires an operator, because a
  script is code running with fleet secrets. Versions are immutable, and rollback
  means activating an earlier version.
- **Upstream pinning (`mcp-proxy`).**
  - At approval the orchestrator stores a hash of the upstream `tools/list`
    (names, descriptions, schemas and annotations).
  - If that list later drifts, affected tools are suspended and the operator sees
    a diff before re-approving. This guards against tool-description
    rug pulls.
  - Descriptions are additionally screened for instruction-like text.
- **Annotations drive policy.** `readOnlyHint` and `destructiveHint` are
  surfaced to agents. A connector can be restricted to read-only tools.
- **Writes.** `connector_call` requires a `request_id`. Write calls are never
  retried automatically. An ambiguous outcome is reported as unknown.
- **Audit.** Every call records connector, version, tool, caller agent, host,
  engine, duration, status and an argument hash. Arguments and results are not
  stored.
- **Fleet controls.** Connectors respect the API kill switch, the engine master
  switches (`activeHostEngines` / `assertHostEngineEnabled`), per-host
  allow-lists and a fleet-wide module toggle like the other optional modules.

## Worked examples

| Service shape | Kind | Egress | Notes |
| --- | --- | --- | --- |
| Remote MCP server with a static bearer token (trackers, ticketing, DNS, notes) | `mcp-proxy` | server | Existing store secrets bind directly |
| Remote MCP server that needs mTLS or a private CA | `mcp-proxy` | server | Client identity and CA come from the store |
| MCP server bound to loopback on one host | `mcp-proxy` | `host:<id>` | Only that host can reach it |
| Billing service whose Skill carries transport plumbing today | `mcp-proxy` | server | Replaces the profile workaround and the hand-written client. A TLS quirk handled by a Python flag must be re-verified with the runner's TLS stack. That Skill currently keeps the credential owner-local; a fleet connector reverses that, which is an operator decision |
| Service reachable only through a delegation gateway for MCP, but with a REST integration API | `script` | server | The script uses the REST API with a personal token, after the service owner agrees to that use. The MCP path waits until the gateway registers a fleet client |

## Phasing

1. **Fleet-wide proxying.** Registry tables, `mcp-proxy` with `egress: server`,
   bearer, header and mTLS auth, the four `connector_*` MCP tools, audit and
   upstream pinning. This alone retires most one-off scripts.
2. **Host egress.** Communicator relay for `host:<id>` connectors.
3. **Script connectors.** Runner sandbox, `connector_put`/`connector_test`,
   operator approval UI, and one REST-only service as the first script.
4. **OAuth upstreams.** The orchestrator acts as the OAuth client and single
   refresher, mirroring how provider accounts work:
   - MCP authorization discovery and PKCE
   - Client ID Metadata Document hosted on the public origin, with Dynamic Client
     Registration as fallback
   - browser login delivered to the operator through the portal
5. **Pins and Skill dependencies.** Native `conn_*` tools, `connectors:`
   frontmatter and the matching `doctor` status.

## Open questions

- **Identity.** A fleet connection acts as one upstream identity everywhere, for
  example the operator's account. Is that acceptable per connector, or do some
  services need per-person bindings?
- **Host relay channel.** Which communicator path carries `host:<id>` calls, and
  how the relay authenticates the requesting agent.
- **Script runtime.** Deno permissions, workerd or an isolate library. The choice
  needs a short spike that covers TLS edge cases, startup cost and memory per call.
- **Native exposure.** How pinned tools reach running sessions, given that
  `tools/list_changed` support differs between engines.
- **Third-party stdio servers.** Run them inside the runner, or never.
- **Quotas and cost.** Per-connector rate limits versus upstream quotas.

## Prior art

These were seen in web research on 2026-11-26 and are not independently verified:

- [Anthropic: code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
  (tools as reusable code, progressive disclosure)
- [Docker Dynamic MCP](https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/)
  (`mcp-find`/`mcp-add`, gateway-held credentials)
- MCP gateways such as Stacklok Virtual MCP Server and MetaMCP (aggregation,
  credential injection)
- [mcporter](https://github.com/steipete/mcporter) and
  [mcptools](https://github.com/f/mcptools) (MCP from the shell)
- [Codex Skills](https://developers.openai.com/codex/skills) (`dependencies.tools`
  with `type: mcp`)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
  (Client ID Metadata Documents, DCR fallback)
- [CSA on tool poisoning and rug pulls](https://labs.cloudsecurityalliance.org/research-rb/csa-whitepaper-mcp-security-tool-poisoning-20260506-csa-styl/)
