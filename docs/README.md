# Documentation

Use the guides and contracts below for current behavior. Dated audits and test
reports record what was observed at a particular revision; they are historical
evidence, not instructions to repeat a rollout or proof of today's runtime state.

## Guides

| Document | Use it for |
| --- | --- |
| [INSTALL](INSTALL.md) | Installation, setup wizard, deployment and backups |
| [USAGE](USAGE.md) | Host user and operator workflows |
| [ADMIN](ADMIN.md) | Admin console and capability matrix |
| [LOGIN](LOGIN.md) | Console login, passkeys and roles |
| [SECURITY](SECURITY.md) | Trust boundaries, encryption and host access |
| [OVERVIEW](OVERVIEW.md) | Architecture, request flow and source map |
| [API](API.md) | HTTP endpoint reference |
| [MCP](MCP.md) | MCP tools and resources |
| [CONFIG_BUILDER](CONFIG_BUILDER.md) | Fleet configuration authoring |
| [Native configuration scopes](NATIVE_CONFIG_SCOPES.md) | Managed defaults versus native settings |
| [Admin console design](admin-ui-design-spec.md) | Current Svelte console implementation contract |

## Interface contracts

Keep these aligned with implementation and executable tests.

| Document | Contract |
| --- | --- |
| [API](interface-api.md) | Server behavior and wire formats |
| [Database](interface-db.md) | Tables, columns and migrations |
| [Codex](interface-cdx.md) | `cdx` lifecycle and commands |
| [Claude](interface-clx.md) | `clx` lifecycle and commands |
| [Grok](interface-cgx.md) | `cgx` lifecycle and commands |
| [JSON schemas](contracts/README.md) | Machine-readable wrapper/server payloads |
| [Host runtime policy](host-runtime-policy.md) | Authoritative host execution rules |

## Feature and operations references

| Area | References |
| --- | --- |
| Wrapper delivery | [Signed wrapper architecture](wrapper-v2-architecture.md) |
| Authentication | [Auth runner](auth-runner.md), [credential resilience](auth-resilience.md) |
| Communicator | [Local communicator](communicator.md), [resident runtime](communicator-resident-runtime.md) |
| Agent conversations | [Operator chat](agent-chat.md), [smart queue](smart-queue.md), [Android companion](android-companion.md) |
| Planned reboot | [One-use session resume](reboot-resume.md) |
| Product assistant | [Chatty](chatty.md) |
| Skills | [Authored manifests and runtime ownership](skills/README.md) |
| Maintenance | [Reusable engine maintenance prompt](prompts/engine-maintenance.md) |

## Evidence and assets

- [Historical reports](archive/README.md): dated audits, investigations, rollout
  procedures and measurements retained for their findings and provenance.
- [Bug audit disposition](bug-audit/2026-10-11-triage.md) and its
  [original report](bug-audit/2026-10-11-source.md): the paired finding ledger.
- [Resident runtime verification](verification/communicator-residency-2026-10-14.md):
  dated acceptance evidence with explicit limits.
- [Gateway matrix receipt](evidence/gateway-matrix-2026-10-15.json): machine-readable
  evidence accompanying the [historical acceptance report](archive/gateway-matrix-2026-10-15.md).
- [Screenshots](img/): images used by the repository README and its capture tooling.

Keep current guides at this level, schemas in `contracts/`, and supporting
artifacts in their dedicated directories. Add future one-off reports to
`archive/` and link them from its index. Reviewable Skill drafts remain in
`skills/`; the database remains their runtime source of truth.
