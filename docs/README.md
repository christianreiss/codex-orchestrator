# Documentation

Use the guides and contracts below for current behavior. Dated audits and test
reports record what was observed at a particular revision; they are historical
evidence, not instructions to repeat a rollout or proof of today's runtime state.

## Guides

| Document | Use it for |
| --- | --- |
| [INSTALL](INSTALL.md) | Installation, setup wizard, instance updates and recovery |
| [USAGE](USAGE.md) | Host user and operator workflows |
| [ADMIN](ADMIN.md) | Admin console and capability matrix |
| [LOGIN](LOGIN.md) | Console login, passkeys and roles |
| [SECURITY](SECURITY.md) | Trust boundaries, encryption and host access |
| [OVERVIEW](OVERVIEW.md) | Architecture, request flow and source map |
| [API](API.md) | HTTP endpoint reference |
| [MCP](MCP.md) | MCP tools and resources |
| [CONFIG_BUILDER](CONFIG_BUILDER.md) | Fleet configuration authoring |
| [Native configuration scopes](NATIVE_CONFIG_SCOPES.md) | Managed defaults versus native settings |
| [Documentation maintenance](documentation-maintenance.md) | Source map and existing documentation verification commands |
| [Web design standard](../DESIGN.md) | Binding rules for every browser surface, research, inventory and migration acceptance |

## Interface contracts

Keep these aligned with implementation and executable tests.

| Document | Contract |
| --- | --- |
| [API](interface-api.md) | Server behavior and wire formats |
| [Database](interface-db.md) | Tables, columns and migrations |
| [Codex](interface-cdx.md) | `cdx` lifecycle and commands |
| [Claude](interface-clx.md) | `clx` lifecycle and commands |
| [Grok](interface-cgx.md) | `cgx` lifecycle and commands |
| [Kimi Code](interface-ckx.md) | `ckx` lifecycle and commands |
| [JSON schemas](contracts/README.md) | Machine-readable wrapper/server payloads |
| [Host runtime policy](host-runtime-policy.md) | Authoritative host execution rules |

## Feature and operations references

| Area | References |
| --- | --- |
| Wrapper delivery | [Signed wrapper architecture](wrapper-v2-architecture.md) |
| Authentication | [Auth runner](auth-runner.md), [credential resilience](auth-resilience.md) |
| Communicator | [Local communicator](communicator.md), [resident runtime](communicator-resident-runtime.md) |
| Agent conversations | [Operator chat](agent-chat.md), [smart queue](smart-queue.md), [Android companion](android-companion.md), [external clients](external-clients.md) |
| Agent supervision | [Fleet task supervisor](agent-supervisor.md) |
| Agent coordination | [Project/host rooms and resource claims](agent-coordination.md), [message timing](agent-messaging-timing.md) |
| Shared work | [Workflows](workflows.md), [file transfers](file-transfers.md), [agent roles](agent-roles.md) |
| Server ownership | [Control-plane owner](control-plane-owner.md), [owner cutover](owner-cutover.md) |
| Planned reboot | [One-use session resume](reboot-resume.md) |
| Heavy host jobs | [Cooperative job memory admission](workload-admission.md) |
| Product assistant | [Chatty](chatty.md) |
| Skills | [Authored manifests and runtime ownership](skills/README.md) |
| External services (proposal) | [Tool connectors](tool-connectors.md): not implemented |
| Maintenance | [Reusable engine maintenance prompt](prompts/engine-maintenance.md) |

## Assets

- [Product tour](../README.md#the-tour) and [images](img/): console screens and the startup cards for all four engines.
- [System review](reports/orchestrator-review.md) and [function matrix](reports/orchestrator-functional-matrix.md): implementation decisions, verified paths and open acceptance boundaries for the recorded revision.

Keep current guides at this level, schemas in `contracts/`, and supporting
artifacts in their dedicated directories. [Acceptance and maintenance reports](reports/)
record their source revisions, tested paths and remaining gaps. Reviewable Skill
drafts live in `skills/`. The database supplies published Skill content.
