# Codex Orchestrator

**One command to rule your AI fleet — Codex and Claude, side by side.**

Codex Orchestrator is a self-hosted Node.js/MySQL control plane for every machine you run OpenAI Codex or Anthropic Claude Code on. Upload your auth once, register your hosts, and let `cdx` (Codex) and `clx` (Claude) handle the rest — syncing credentials, config, skills, instructions, and usage data, while a native MCP server gives every agent in the fleet shared memory, secrets, project boards, merge arbitration, peer messaging, and a file drop. You never copy a token by hand again, and your agents stop working in isolation.

A host can run Codex, Claude, or both. One admin console manages both engines.

> **Both engines are first-class.** `cdx` and `clx` are two personas of the same `cxx` wrapper binary, so auth, config, skills, agent documents, MCP, usage, messaging, and the safety controls are at parity — each delivered in its engine's native form. The matrix below is the exact list of what is engine-specific. Please report anything that breaks.

[![Codex wrapper status showing fleet sync, policy, versions, and quota checks before launch](docs/img/cdx-cli.png)](docs/img/cdx-cli.png)

*`cdx` verifies fleet policy, auth, versions, quota, skills, and MCP before handing control to Codex.*

## What does it actually do?

**Multi-engine fleet management**
- Deploy **Codex** (`cdx`) and/or **Claude Code** (`clx`) on any host. Both are aliases of one installed `cxx` binary and share one host API key.
- Skills, AGENTS.md / CLAUDE.md, and MCP memories are shared across both engines by default.
- Engine-native config: `config.toml` for Codex, `settings.json` for Claude (deep-merged, so your own keys survive).

**Sync everything, everywhere**
- Auth, config, skills, and agent instructions converge on every host each time you run `cdx` or `clx` — one `POST /sync/bootstrap` round-trip, then straight into the engine.
- Each host gets its own Ed25519-signed config carrying its own API key. No shared secrets floating around.
- Engine upgrades happen in the background on a 15-minute schedule, into private prefixes, and switch over atomically — launches never wait on npm.

**Give your agents a team**
- **Memory** in three scopes: host-local scratch, per-project facts, and fleet-wide shared documents with full-text search and concurrent-safe append.
- **Projects / CoCo**: shared notes, files, feedback, project memory, and a **Kanban board** whose cards agents claim with a lease — so two agents never pick up the same work.
- **Git Director**: agents register the clone they are working in and ask before merging to a shared branch. Verdicts are `allow`, `wait`, or `deny`, decided by policy, a model, or you from the console.
- **Agent Messaging**: an encrypted, ordered, at-least-once bus between Codex and Claude agents on any host, plus live two-party `#call` sessions and chaired `#conference` rooms.
- **File Transfer**: a TTL'd pool where agents hand each other build artifacts, heap dumps, or tarballs, chunked over MCP and audited on every fetch.
- **Secrets**: working credentials (GitHub tokens, database passwords, service keys) delivered over MCP on demand, never written to disk by the orchestrator, every read audited.

**Talk to your agents from anywhere**
- The **Agent Portal** (`/go`) is a mobile-friendly page where a running agent reports what it is doing, asks you questions, and takes instructions — via a permanent magic link or your console login.
- **Active Clients** shows every running `cdx`/`clx` session in the fleet: presence, current task, Git Director branch, messaging address, and a one-click force close.
- `#afk` lets an agent keep working while you step away, raising a **Needs you** banner only when it actually needs a decision.

**Stay safe without thinking about it**
- Auth payloads and every secret column are encrypted at rest with libsodium secretbox; keys rotate with KID tracking.
- API keys are hashed and IP-bound on first use. A sidecar runner verifies credentials before they are accepted.
- Hosts you don't trust to keep credentials on disk? Mark them **insecure**: auth is purged after the last wrapper process exits, and access needs an approval — per host, per domain, or fleet-wide while you are at your desk.
- Six console roles behind a default-deny capability matrix, passkey (WebAuthn) login, and a global kill switch to cut host access fleet-wide in seconds.

**See what's happening**
- Fleet health, sync activity, version drift, ChatGPT quota windows, and Claude usage on one dashboard.
- Quota warnings nudge you before you hit limits. VIP hosts can bypass them when it matters.
- An audit trail and MCP request log for everything hosts and operators do.

**Stay in control**
- Pin Codex or Claude to a specific version fleet-wide, or let individual hosts override.
- Author skills, fleet instructions, Claude subagents, commands, and output styles once; serve them everywhere.
- Set a security posture per host with graduated policy profiles, and preview exactly what each host will be served.

**Expose compatible APIs**
- `/v1/` speaks the OpenAI protocol — point any OpenAI SDK client at your orchestrator.
- `/anthropic/v1/` speaks the Anthropic protocol — point any Anthropic SDK client at your orchestrator.
- Revocable, expiring `sk-coco-` keys, each lane switchable independently.

## Codex vs Claude: feature matrix

Legend: ✅ supported · 🅱️ beta · — not supported

| Capability | Codex (`cdx`) | Claude (`clx`) |
|---|---|---|
| Daily-driver wrapper | ✅ | ✅ |
| Auth sync (account-login) | ✅ `auth.json` | ✅ native `claudeAiOauth` |
| Config sync | ✅ `config.toml` | ✅ `settings.json` (deep-merge, keeps your keys) |
| Per-host API key + signed config | ✅ | ✅ |
| Wrapper self-update & version pinning | ✅ | ✅ |
| Background engine upgrades | ✅ | ✅ |
| Shared skills | ✅ via MCP `skill://` | ✅ on-disk `~/.claude/skills/` |
| Agent doc sync | ✅ `AGENTS.md` | ✅ `CLAUDE.md` (shared pipeline) |
| MCP memory, projects, board, secrets | ✅ | ✅ |
| Git Director & File Transfer | ✅ | ✅ |
| Agent Messaging (`#call`, `#conference`) | ✅ | ✅ (with ringer hooks) |
| Agent Portal & `#afk` | ✅ | ✅ |
| Usage / token tracking | ✅ ChatGPT quota snapshots | ✅ host-reported Claude usage |
| Insecure-host purge & kill switch | ✅ | ✅ |
| Compatible passthrough API | ✅ `/v1/` (OpenAI) | ✅ `/anthropic/v1/` (Anthropic) |
| Lanes & profiles (`lane`, `profile`) | ✅ | — |
| Native collections (subagents / commands / output-styles) | — | ✅ |
| Quota status line | — | ✅ `cxx claude-quota-statusline` |
| Advisor model (experimental reviewer) | — | 🅱️ `advisorModel` (opus/sonnet/fable) |

The core fleet machinery is at parity because `cdx` and `clx` are personas of one `cxx` binary. Lanes and profiles are Codex-only; Claude's native on-disk collections have no Codex analogue. The one 🅱️ row surfaces an experimental Claude Code feature and stays off unless you set it.

## Is this for me?

You'll get the most out of this if:

- You run Codex and/or Claude Code on **more than one machine** and want a single source of truth for auth and config.
- You run **more than one agent at a time** and want them to share memory, split work on a board, and not step on each other's merges.
- You want **per-host API keys** with IP binding, instead of one token pasted everywhere.
- You need **visibility** into which hosts and engines are burning tokens, what every agent is doing right now, and a way to set limits.
- You'd like to manage **skills and agent instructions** from one place instead of scattering files across machines.
- You want a **kill switch**, an approval queue, and quota controls you can pull from a dashboard — or from your phone.
- You want **OpenAI and Anthropic compatible APIs** you can point third-party tools at without exposing your real API keys.

If you only use one AI tool on one laptop, this is probably overkill — but we won't judge if you set it up anyway.

## Get started in 5 minutes

All you need is Docker with the Compose v2 plugin, plus `curl` and `openssl`.

```bash
bin/install.sh
```

That's it. The guided installer walks twelve steps: it generates every
installation-owned secret, wires TLS (ACME, your own certificate, self-signed,
or none behind your proxy), builds a four-platform `cxx` fleet trusted only by
this installation, provisions the database schema, starts the stack, creates
your first owner, and verifies readiness. It prints `READY` and the console URL
only after every critical check passes; anything short of that prints
`INCOMPLETE` and exits non-zero.

Every step is re-runnable, so an interrupted install resumes rather than starting
over. `bin/install.sh doctor` diagnoses an existing one and names the command
that fixes each problem.

Driving it from a script or an agent:

```bash
bin/install.sh --json --non-interactive \
  --url https://codex.example.com --tls acme --acme-email ops@example.com \
  --admin-name "Ada Lovelace" --admin-user ada --admin-email ada@example.com \
  --admin-pass-file /run/secrets/owner-password
```

One JSON object per step on stdout, human output on stderr. See
[`docs/INSTALL.md`](docs/INSTALL.md) for every flag and for staged-deployment
options.

### Onboard your first host

Open the console and the setup wizard walks you through it — nine steps, the
first two required and the rest skippable:

1. **Infrastructure** — the six readiness checks, with the command that fixes
   each one. Nothing here is fixable from a browser, so it reports rather than
   pretends.
2. **Owner** — the one-time claim, which also signs you in.
3. **Engines** — Codex, Claude, both, or neither.
4. **Credentials** — one canonical credential per engine, verified against the
   live provider before it is stored. A bad value fails here, not on a host at
   3am.
5. **Fleet defaults** — model and reasoning effort. This is also the write that
   activates MCP for the fleet; skills, memory, projects and secrets stay dark
   until it lands.
6. **Agent policy** — the seeded fleet policy, plus a box for your house rules.
7. **Modules** — Projects and Secrets, both off until you say otherwise.
8. **Collaboration** — the agent portal (you ↔ agent) and agent messaging
   (agent ↔ agent). Also off by default, deliberately.
9. **First host** — optional. Registering one mints its API key and a one-time
   installer command:
   ```bash
   curl https://your-server/install/<token> | bash
   ```

Progress is saved, so leaving mid-way is fine — the dashboard offers to resume.
Codex hosts run `cdx`, Claude hosts run `clx`, and dual-engine hosts get both
aliases backed by one `cxx` install. Git Director, the project board, and File
Transfer each have their own switch on their console page.

Secure hosts keep auth on disk and work offline (24h fresh window, 7d fallback).
On insecure hosts, every auth-aware cdx/clx invocation shares a session lease;
the last exiting process purges native credentials while preserving explicit
logout intent. The next retrieve needs an approval: a single host for eight
hours, a whole domain (optionally permanent), or a fleet-wide window while you
are at your desk.

## See it in action

All screenshots use documentation-safe demo data. Click any image for the full-resolution view.

### Fleet state at a glance

[![Admin overview showing fleet health, releases, quota windows, and runner state](docs/img/fleet-overview.png)](docs/img/fleet-overview.png)

*See fleet health, upstream releases, quota pressure, and both verification runners without tab hunting.*

### Every host, one control plane

[![Host inventory showing engine coverage, status, versions, and trust state](docs/img/host-inventory.png)](docs/img/host-inventory.png)

*Search and filter the fleet while engine coverage, sync health, version drift, and trust state remain visible.*

### One machine, all the context

[![Host detail showing auth drift, versions, policy, engines, and lifecycle controls](docs/img/host-detail.png)](docs/img/host-detail.png)

*Inspect auth drift, versions, model overrides, IP policy, engines, and lifecycle controls from one page.*

### Author once. Serve everywhere.

[![Authoring workspace for shared agent instructions and version history](docs/img/authoring-agents.png)](docs/img/authoring-agents.png)

*Version shared fleet instructions, choose exactly what is served, and manage cross-engine context from one workspace.*

### Shared context for both engines

[![Project workspace with shared notes, todos, files, feedback, and activity](docs/img/project-workspace.png)](docs/img/project-workspace.png)

*Give Codex and Claude the same notes, board, files, feedback, and append-only activity trail.*

### Compatible APIs, scoped credentials

[![API access page with compatible endpoints and scoped key controls](docs/img/api-access.png)](docs/img/api-access.png)

*Copy either compatible base URL, gate each proxy independently, and issue revocable, expiring keys.*

## Day-to-day: the `cdx` and `clx` commands

Once a host is provisioned, `cdx` (or `clx`) is your daily driver:

```bash
cdx                              # sync and launch with fleet defaults
cdx myprofile                    # use a named profile from config.toml
cdx --execute "show me open PRs" # one-shot, script-friendly output
clx -c                           # continue the last Claude conversation
```

A few more handy ones:

```bash
cdx status          # quick health check
cdx doctor          # diagnose SSH, PTY, and API issues
cdx sync            # converge auth, config, and content without launching
cdx auth-upload     # upload current ~/.codex/auth.json after codex login
cdx lane spark      # switch to the Spark lane for this host
cdx ls              # shortcut for lane spark
cdx --update        # self-update the wrapper, then re-sync
cdx --uninstall     # remove this engine; the last one decommissions the host
```

The shared `cxx` binary adds host-wide commands: `cxx sync` converges every
engine at once, `cxx cron run` pulls a pending engine upgrade now, and
`cxx portal say|ask|resolve` lets an agent talk to you through the portal.

## Agents that work together

Every host reaches the orchestrator's MCP server, and both engines get the same
tools. A short tour of what an agent can do out of the box:

```text
shared_memory_search "deploy crane"       # find a fleet runbook another agent wrote
project_bootstrap    "checkout-v2"        # read the project, its board, and recent changes
project_card_claim   card=42 role=code    # take a card; nobody else can claim it now
git_join             branch=main paths=…  # say what you are about to touch
git_merge_request    …                    # allow / wait / deny before you merge
secret_get           "github-deploy"      # fetch a credential, audited, never on disk
transfer_put         name=report.tgz …    # hand a peer a file; it expires on its own
agent_send           to=… "PR is up"      # message the Claude agent on host02
```

Agents on the same host share one API key, and every tool family has its own
switch in the console, so nothing is reachable until you turn it on. The
served AGENTS.md / CLAUDE.md gains one concise guidance block per enabled
feature, so agents learn the house rules without you writing them twice.

## OpenAI-compatible API

The orchestrator exposes an OpenAI-compatible REST API at `/v1/`. Any tool that speaks the OpenAI protocol (SDKs, CLI clients, IDE plugins) can use it.

1. **Create a key** in Admin > API Access.
2. **Point your client** at the orchestrator:
   ```python
   import openai
   client = openai.OpenAI(
       base_url="https://your-server/v1",
       api_key="sk-coco-...",
   )
   response = client.chat.completions.create(
       model="gpt-6-astra",
       messages=[{"role": "user", "content": "Hello!"}],
   )
   ```

Supported endpoints: `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, `/v1/models`, and `/v1/models/{model}`. Embeddings return an OpenAI-shaped `unsupported_endpoint` error. Streaming (`stream: true`) on chat and legacy completions replays the finished answer as standard SSE chunks; the Responses endpoint does not stream.

The Anthropic lane at `/anthropic/v1/messages` (plus `count_tokens`, `models`, and the legacy `complete`) works the same way with an Anthropic SDK and the same `sk-coco-` keys.

## Under the hood

Codex Orchestrator takes security seriously so you can focus on building things:

- **Encryption**: All auth payloads and secret columns use libsodium secretbox. Keys are rotated with KID tracking. The one plaintext store is the file-transfer pool on the data volume, which expires on its own.
- **Runner validation**: A sidecar service validates auth before writes are accepted — transparent to reads.
- **Request admission**: The orchestrator does not impose local request-rate limits; deploy an external edge policy if traffic shaping is required.
- **Session-gated admin**: `/admin/*` is protected by the admin session cookie, with passkey (WebAuthn) login. Six roles sit behind a default-deny capability matrix; content-revealing reads (secrets, credentials, transcripts, transfer downloads) carry their own capability. A proxy in front may terminate mTLS and forward `X-MTLS-*`, which the API reads from trusted peers only.
- **IP binding**: Each host's API key locks to its IP on first use, with optional roaming support.
- **Hardened containers**: pinned base images, non-root, read-only root filesystem, all capabilities dropped.

For the full API surface, MCP details, and architecture deep-dive, check the docs below.

## Memory management

Memory is split into three intentional scopes so scratch notes, workstream facts,
and fleet knowledge do not blur together:

- **Host** — host-local scratch through `memory_*` / `memory://`; isolated per
  host.
- **Project** — short durable facts for one workstream through
  `project_memory_*` / `project://{slug}/memory/{key}`; discoverable by every
  host participating in that project.
- **Shared** — fleet-wide reference documents through `shared_memory_*` /
  `shared://{slug}`; chunked, full-text indexed, and safe for concurrent append.
- **Memory Atlas** — the Memories page visualizes all three stores as
  an explicit relationship graph or accessible list, with search and scope,
  host, project, tag, and engine filters. Its inspector supports create, read,
  edit, shared append, permanent delete, and retention-bound operational
  activity. Updates and deletes use ETags so stale edits fail with a conflict
  instead of silently overwriting newer state; only owner/admin accounts can
  mutate memories.

## Skill management

Skills are stored centrally and delivered in each engine's native form — no manual copying between machines.

- **Engine-native delivery** — Codex reads `skill://{slug}` through MCP; Claude receives managed `~/.claude/skills/<slug>/` directories during bootstrap. The wrapper cleans up obsolete mirrors without touching user-owned Claude Skills.
- **Admin authoring** — create, edit, and delete skills from the Skills page. Descriptions and drafts can be AI-generated via the runner, and a curated upstream skill source can be imported with one switch.
- **Managed skills** — `#coco` (project workflow), `#afk` (portal relay), `#conference` (multi-agent rooms), and `skill-manager` ship with the orchestrator and appear as their modules are enabled.
- **Integrity tracking** — every skill carries a SHA256 hash so the sync pipeline knows when content has actually changed.
- **MCP-first Codex routing** — when the managed MCP is usable, the baked Codex config disables the built-in local `skill-creator`; served AGENTS guidance uses `skill_list` first for fleet-Skill requests and routes management requests to `skill://skill-manager`. Claude continues to use its native synced Skill directories.

## Dynamic AGENTS.md and CLAUDE.md

The agent document is version-controlled on the server as canonical base Markdown and assembled for each engine and host at sync time.

- **Versioned** — every save creates a new immutable version. The admin can revert to any previous version or lock serving to a specific one.
- **Serve modes** — `latest` always serves the newest version; `locked` pins to a chosen version. Per-host overrides are supported.
- **Policy profiles** — a graduated security posture (what an agent may do without asking) is chosen per host from named profiles, and the Fleet Instructions page previews the exact document any host will receive.
- **Dynamic feature guidance** — one block delimited by `<!-- cxx:managed-features:start -->` and `<!-- cxx:managed-features:end -->` adds only the concise hints that apply: MCP-first fleet-Skill discovery, memory routing, Projects/CoCo, Codex-only BrowserOS, the secrets workflow, Agent Messaging, Git Director, and File Transfer. Canonical inventories are never embedded in the document.
- **Change detection** — the wrapper sends its local SHA256; the server responds with `unchanged` (skip write) or `updated` (atomic file replace). Three hashes are tracked: base document, managed sections, and final combined.
- **Seeded on boot** — if the database is empty, the server seeds from the repo's `AGENTS.md` file on first start.
- **Admin dashboard** — edit the canonical base, view version history, and control serve mode from the Fleet Instructions page; host-specific hints are appended only when the document is served.

## Documentation

| Doc | What's inside |
|-----|---------------|
| [`INSTALL.md`](docs/INSTALL.md) | Install wizard, Docker services, TLS, backups |
| [`USAGE.md`](docs/USAGE.md) | Host user and operator workflows |
| [`OVERVIEW.md`](docs/OVERVIEW.md) | Architecture, auth flow, sync pipeline, code map |
| [`SECURITY.md`](docs/SECURITY.md) | Threat model, encryption, roles, insecure-host rules |
| [`LOGIN.md`](docs/LOGIN.md) | Console login, passkeys, roles and capabilities |
| [`API.md`](docs/API.md) | Full HTTP API reference |
| [`MCP.md`](docs/MCP.md) | MCP server tools and resources |
| [`CONFIG_BUILDER.md`](docs/CONFIG_BUILDER.md) | Fleet config.toml builder |
| [`ADMIN.md`](docs/ADMIN.md) | Admin console guide and capability matrix |
| [`interface-api.md`](docs/interface-api.md) | API interface contracts |
| [`interface-db.md`](docs/interface-db.md) | Database schema reference |
| [`interface-cdx.md`](docs/interface-cdx.md) | Codex wrapper interface contract |
| [`interface-clx.md`](docs/interface-clx.md) | Claude wrapper interface contract |
| [`wrapper-v2-architecture.md`](docs/wrapper-v2-architecture.md) | How the signed `cxx` wrapper is built and updated |
| [`auth-runner.md`](docs/auth-runner.md) / [`auth-resilience.md`](docs/auth-resilience.md) | Credential verification and recovery |
| [`contracts/`](docs/contracts/README.md) | JSON schemas for the wrapper ↔ server contract |

The console also ships its own operator manual under **Manual**.

## License

[GNU General Public License v3](LICENSE)
