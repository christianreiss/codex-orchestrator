# Codex Orchestrator

**One command to rule your Codex fleet.**

Codex Orchestrator is a self-hosted PHP/MySQL service that keeps OpenAI Codex running smoothly across every machine you own. Upload your auth once, register your hosts, and let `cdx` handle the rest — syncing credentials, config, AGENTS.md, and usage data while serving Skills canonically through MCP so you never have to copy a token by hand again.

![Host-specific installer baking and sync flow](docs/img/cdx.png)

## What does it actually do?

**Sync everything, everywhere**
- Your `auth.json`, `config.toml`, slash commands, and `AGENTS.md` stay in sync across every host — automatically, every time you run `cdx`.
- Skills are served canonically through MCP `skill://{slug}` resources instead of per-host local copies.
- Each host gets its own API key baked right into the wrapper. No shared secrets floating around.

**Stay safe without thinking about it**
- Auth payloads are encrypted at rest. API keys are hashed and IP-bound on first use.
- Hosts you don't trust to keep credentials on disk? Mark them "insecure" — auth gets purged after every run.
- A global kill switch lets you cut API access fleet-wide in seconds if something goes sideways.

**See what's happening**
- Track token usage and costs per host with built-in dashboards.
- Quota warnings nudge you before you hit limits. VIP hosts can bypass them when it matters.
- ChatGPT quota snapshots refresh automatically so you always know where you stand.

**Stay in control**
- Pin Codex to a specific version fleet-wide, or let individual hosts override.
- The `cdx` wrapper self-updates from your server — no manual upgrades.
- An admin dashboard covers host management, content editing, usage monitoring, and more.

**Expose an OpenAI-compatible API**
- The built-in `/v1/` endpoints speak the OpenAI protocol — point any OpenAI SDK client at your orchestrator.
- Manage API keys (`sk-coco-` prefix) from the admin dashboard with per-key rate limits and expiration.
- Prompt execution is delegated to the runner container, so no extra infrastructure is needed.

**Collaborate across agents**
- The optional Projects module gives your agents shared notes, todos, files, and feedback with append-only change history.
- A native MCP server provides host-scoped memory tools plus shared project resources.

## Is this for me?

You'll get the most out of this if:

- You run Codex on **more than one machine** and want a single source of truth for auth and config.
- You want **per-host API keys** with IP binding, instead of one token pasted everywhere.
- You need **visibility** into who's using what, how much it costs, and a way to set limits.
- You'd like to manage **skills and AGENTS.md** from one place instead of scattering files across machines.
- You want a **kill switch** and quota controls you can pull from a dashboard.
- You want an **OpenAI-compatible API** you can point third-party tools at without exposing your real API keys.

If you only use Codex on one laptop, this is probably overkill — but we won't judge if you set it up anyway.

## Get started in 5 minutes

All you need is Docker and Docker Compose.

```bash
bin/setup.sh
```

That's it. The guided installer walks you through `.env` configuration, data directories, TLS setup, and (unless you opt out) builds and starts the whole stack. See [`docs/INSTALL.md`](docs/INSTALL.md) for non-interactive flags and advanced options.

### Onboard your first host

1. **Upload your auth** — go to Admin and upload your canonical `~/.codex/auth.json`. You only do this once.
2. **Register a host** — Admin, Hosts, New Host. You'll get an installer command.
3. **Run the installer** on the target machine:
   ```bash
   curl https://your-server/install/<token> | bash
   ```
4. **Done.** From now on, just run `cdx` and everything syncs.

Secure hosts keep auth on disk and work offline (24h fresh window, 7d fallback). Insecure hosts purge auth after each run and need an open window from the admin.

## See it in action

![Admin dashboard overview](docs/img/dashboard_1.png)
![Per-host digests and validation logs](docs/img/dashboard_2.png)
![Token usage aggregates and recent activity](docs/img/dashboard_3.png)

## Day-to-day: the `cdx` command

Once a host is provisioned, `cdx` is your daily driver:

```bash
cdx                              # sync and launch with fleet defaults
cdx myprofile                    # use a named profile from config.toml
cdx --execute "show me open PRs" # one-shot, script-friendly output
```

A few more handy ones:

```bash
cdx status          # quick health check
cdx doctor          # diagnose SSH, PTY, and API issues
cdx lane spark      # switch to Spark lane for this run
cdx ls              # shortcut for lane spark
cdx --update        # force-update the wrapper and Codex
cdx --uninstall     # remove everything and decommission
```

## OpenAI-compatible API

The orchestrator exposes an OpenAI-compatible REST API at `/v1/`. Any tool that speaks the OpenAI protocol (SDKs, CLI clients, IDE plugins) can use it.

1. **Create a key** in Admin > Settings > API Keys.
2. **Point your client** at the orchestrator:
   ```python
   import openai
   client = openai.OpenAI(
       base_url="https://your-server/v1",
       api_key="sk-coco-...",
   )
   response = client.chat.completions.create(
       model="cdx-lm-1",
       messages=[{"role": "user", "content": "Hello!"}],
   )
   ```

Supported endpoints: `/v1/chat/completions`, `/v1/completions`, `/v1/models`. Embeddings returns a `not_implemented` error. Streaming (`stream: true`) sends a single SSE frame with the full response.

## Under the hood

Codex Orchestrator takes security seriously so you can focus on building things:

- **Encryption**: All auth payloads use libsodium secretbox. Keys are rotated with KID tracking.
- **Runner validation**: A sidecar service validates auth before writes are accepted — transparent to reads.
- **Rate limiting**: All non-admin routes are rate-limited, with a dedicated bucket for auth failures.
- **mTLS admin access**: The admin API defaults to mutual TLS. Passkey (WebAuthn) login is available too.
- **IP binding**: Each host's API key locks to its IP on first use, with optional roaming support.

For the full API surface, MCP details, and architecture deep-dive, check the docs below.

## Documentation

| Doc | What's inside |
|-----|---------------|
| [`INSTALL.md`](docs/INSTALL.md) | Setup, Docker services, TLS, mTLS, backups |
| [`USAGE.md`](docs/USAGE.md) | Host user and operator workflows |
| [`OVERVIEW.md`](docs/OVERVIEW.md) | Architecture, auth flow, sync pipeline |
| [`API.md`](docs/API.md) | Full HTTP API reference |
| [`MCP.md`](docs/MCP.md) | MCP server tools and resources |
| [`CONFIG_BUILDER.md`](docs/CONFIG_BUILDER.md) | Fleet config.toml builder |
| [`ADMIN.md`](docs/ADMIN.md) | Admin dashboard guide |
| [`DESIGN.md`](DESIGN.md) | OpenAI-compatible API design |
| [`interface-api.md`](docs/interface-api.md) | API interface contracts |
| [`interface-db.md`](docs/interface-db.md) | Database schema reference |
| [`interface-cdx.md`](docs/interface-cdx.md) | Wrapper interface contracts |

## License

[GNU General Public License v3](LICENSE)
