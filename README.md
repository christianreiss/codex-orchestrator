# Codex Auth Central API

🔒 Keep one canonical Codex `auth.json` for your whole fleet. 🚀 Mint per-host API keys from the dashboard, bake them into the `cdx` wrapper, and let hosts pull/push auth + usage with a single call.

![cdx wrapper baking a host-specific installer and syncing auth](docs/img/cdx.png)

## Why you might like it

- 🌐 One `/auth` flow to keep every host in sync (retrieve/store with version metadata).
- 🗝️ Per-host API keys, IP-bound on first contact; single-use installer tokens bake config into `cdx`.
- 📊 Auditing and usage: token usage, versions, IPs, and runner validation logs.
- 🔒 Canonical auth + tokens encrypted at rest (libsodium).
- 🧠 Extras: slash-command distribution, ChatGPT quota snapshots, and daily pricing pulls for cost dashboards.

## See it in action

- **Dashboard overview** — track host health, latest digests, versions, and API usage at a glance.
- **Host detail** — inspect canonical auth digests, recent validations, and roaming status per host.
- **Token usage** — visualize per-host token consumption (total/input/output/cached/reasoning) for billing or investigations.

![Admin dashboard overview screen](docs/img/dashboard_1.png)

![Per-host digests and validation logs](docs/img/dashboard_2.png)

![Token usage aggregates and recent activity](docs/img/dashboard_3.png)

## Get going fast

```bash
cp .env.example .env          # set DB_* creds (match docker-compose)
docker compose up --build     # API on http://localhost:8488 with MySQL sidecar
```

No external proxy? Enable the bundled Caddy TLS/mTLS frontend (serves 443, optional LE or custom cert): `docker compose --profile caddy up --build -d` after setting the `CADDY_*` vars. Details: `docs/INSTALL.md`.

## Contributing / local dev

- `composer install`
- `php -S localhost:8080 -t public`
- Ensure `storage/` is writable by PHP.

## Documentation

- Installation and deployment (including `bin/setup.sh`, TLS/mTLS, and Docker profiles): `docs/INSTALL.md`
- System overview, request flow, and operational notes: `docs/OVERVIEW.md`
- Human-friendly API surface overview: `docs/API.md`
- Source-of-truth interface contracts: `docs/interface-api.md`, `docs/interface-cdx.md`, `docs/interface-db.md`
- Auth runner behavior and probes: `docs/auth-runner.md`
- Security policy and hardening checklist: `docs/SECURITY.md`
