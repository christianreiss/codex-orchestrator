# Chat app OAuth connectors

Connector access is **off by default**, independently of managed engine login and the existing fleet `/mcp` endpoint. Open **Coordination → Connectors**. An administrator enables the service and each permitted chat app, selects the permission ceiling, hosts and projects, and saves. Users then connect with their own dashboard account.

Use the setup steps on that page: URLs are generated from `PUBLIC_BASE_URL`, which must be a canonical public HTTPS origin. The provider's cloud must reach it. No host API key or provider subscription credential belongs in a connector setup field.

## Permissions

Every call intersects the user's strict role capabilities, administrator ceiling, immutable user consent and target allowlists. Empty host/project lists grant no targets. Fleet-wide shared memory, skills and workflows need explicit global scope. Read/write is per category. Tool restrictions further narrow it. Sensitive grants separately control deletion, secret metadata, secret values and delegation.

Delegation is arbitrary work within the chosen managed agent's authority, including potentially shell commands, deployment or reboot. A project allowlist does **not** sandbox that delegated work. It uses durable `request` messages and explicit task results. The `work_result` tool distinguishes delivery state from reported success/failure; an accepted delivery alone is not success. Queued connector work must still have valid authority before delivery. Revoking a connection cannot undo work already accepted or running.

New tools and broader policy never expand an existing connection. Reductions apply immediately. Disabling the global/provider switch removes affected grants; re-enabling requires reconnection. Users can revoke their own connections; administrators can revoke any connection.

## OAuth contract

- Resource: `/connectors/mcp`, JSON Streamable HTTP responses, tools only. Resources/prompts and unclassified methods are unavailable.
- Discovery: `/.well-known/oauth-protected-resource/connectors/mcp` and `/.well-known/oauth-authorization-server`.
- Authorization: `/oauth/authorize`, existing dashboard login and explicit consent.
- Token/revocation: `/oauth/token`, `/oauth/revoke`; form-urlencoded requests. Only authorization code + S256 PKCE and rotating refresh tokens are supported. Codes live 60 seconds, access 15 minutes, grants/refresh 30 days. `resource` must exactly equal the displayed MCP URL. Redirect matching is exact, with issuer identification in callbacks.
- Registration: `/oauth/register?provider=chatgpt|claude|grok`, or supported published client metadata. DCR client names/provider labels are supplied by clients, not proof of provider identity. OAuth authenticates the consenting dashboard user.
- Opaque credential hashes and consent metadata live in `connector_records`, owned by the control-plane owner. Code consumption, token rotation and request consumption are atomic. Refresh-token reuse revokes the grant. Expired temporary records are pruned during connector mutations; record capacity and endpoint limits bound registration abuse.

## Provider setup

ChatGPT: Settings → Apps, enable developer mode where your plan/workspace requires it, add the remote MCP URL and choose OAuth. Use the exact callback displayed by ChatGPT if manually registering a client. Both automatic registration and supported published identity documents are accepted.

Claude: Customize → Connectors → Add custom connector. Organization owners may need to provision it first. Choose automatic registration, or supported published identity. Hosted Claude callbacks use `https://claude.ai/api/mcp/auth_callback`.

Grok: `https://grok.com/connectors` → New Connector → Custom MCP. Business/Enterprise administrators provision the connector first. Complete OAuth sign-in and invoke an authorized tool.

Provider instructions were checked against the official OpenAI authentication guide, Claude connector/authentication documentation and xAI connector documentation on 2026-11-08. Provider UI wording may change. Installation readiness, completed authorization and a successful provider tool call are separate evidence levels.

## Operations

Default-off deployment requires no existing credential migration. Migration 0129 creates the new table idempotently. Roll back application code while leaving the additive table in place; disable/revoke connectors before rollback. Never restore old token/grant rows to reactivate a connection.

Connector-origin work cannot be redriven from the general admin queue: submit a fresh request through the current OAuth connection so the current grant and target are checked again.
