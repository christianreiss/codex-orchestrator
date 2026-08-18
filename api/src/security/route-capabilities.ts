/**
 * The route→capability inventory: every route Fastify registers under
 * `/admin/*`, plus the session-guarded `/cli/auth/*` routes, mapped to the one
 * capability that opens it.
 *
 * This is deliberately a table rather than an argument threaded through 222
 * route registrations. The whole authorization surface is one file a reviewer
 * can read top to bottom, and `http/plugins/capabilities.ts` refuses to start
 * the server when a registered route has no entry here — so a new route cannot
 * reach production ungated, and a deleted route cannot leave a stale grant
 * behind. `test/unit/security/route-capability-coverage.test.ts` runs the same
 * check in CI against the real route tree.
 *
 * Keys are `METHOD /pattern`, where the pattern is exactly the string passed to
 * `app.get`/`app.post`/… — not a request URL. Fastify prefers a static segment
 * over a parametric one, so `/admin/claude/state` and `/admin/claude/:kind` are
 * separate entries and the static one wins at dispatch. `HEAD` is resolved
 * against its `GET` entry, since Fastify derives head routes from get routes.
 */

import type { Capability } from './capabilities.js';

export type RouteGuard =
  /** Reachable without a session, with the reason it has to be. */
  | { readonly kind: 'public'; readonly reason: string }
  /** Requires an active session holding `capability`. */
  | { readonly kind: 'capability'; readonly capability: Capability }
  /**
   * Requires `capability` once the installation has an owner. Before that the
   * route's own handler runs unauthenticated so the first account can be
   * created; the moment a session exists, the capability is enforced like any
   * other. Used only by the bootstrap surface.
   */
  | {
      readonly kind: 'capability-after-bootstrap';
      readonly capability: Capability;
      readonly reason: string;
    };

const cap = (capability: Capability): RouteGuard => ({ kind: 'capability', capability });
const open = (reason: string): RouteGuard => ({ kind: 'public', reason });
const bootstrap = (capability: Capability, reason: string): RouteGuard => ({
  kind: 'capability-after-bootstrap',
  capability,
  reason,
});

export const ROUTE_CAPABILITIES: Readonly<Record<string, RouteGuard>> = {
  // ── Pre-authentication surface ───────────────────────────────────────────
  // The caller is by definition not yet authenticated on any of these. Each
  // one is its own rate-limited, audited flow inside the handler.
  'GET /admin/auth/status': open('login screen probe: reports whether setup is complete'),
  'POST /admin/auth/login': open('password login'),
  'POST /admin/auth/login/method': open('asks which login methods a username offers'),
  'POST /admin/auth/passkey/login': open('passkey assertion'),
  'POST /admin/auth/passkey/login/options': open('passkey assertion challenge'),
  'POST /admin/auth/password/request': open('password reset request (emails a token)'),
  'POST /admin/auth/password/reset': open('password reset redemption (token is the credential)'),
  // The device-code lanes. The wrapper holds no session — the one-time code it
  // polls with is the credential, and approval is a separate gated action.
  'POST /cli/auth/start': open('device-code start; the wrapper has no session yet'),
  'POST /cli/auth/poll/:id': open('device-code poll; the request id is the credential'),
  'GET /cli/auth/verify': open('device-code verification landing page'),
  // Served by @fastify/static: the built SPA bundle and the manual's assets.
  // Static files only — every byte behind them is fetched by an authenticated
  // XHR from the SPA itself.
  'GET /admin/*': open('static SPA bundle and manual assets'),

  // ── Your own account ─────────────────────────────────────────────────────
  'POST /admin/auth/logout': cap('account.self_manage'),
  'POST /admin/auth/password/change': cap('account.self_manage'),
  'POST /admin/auth/passkey/register': cap('account.self_manage'),
  'POST /admin/auth/passkey/register/options': cap('account.self_manage'),
  'GET /admin/passkeys': cap('account.self_manage'),
  'DELETE /admin/passkeys/:id': cap('account.self_manage'),
  'POST /admin/passkeys/:id/name': cap('account.self_manage'),

  // ── Console-wide reads ───────────────────────────────────────────────────
  'GET /admin/overview': cap('admin.read'),
  'GET /admin/ws': cap('admin.read'),
  'GET /admin/ws/info': cap('admin.read'),
  'GET /admin/theme': cap('admin.read'),
  'GET /admin/manual/manifest': cap('admin.read'),
  'GET /admin/manual/article/:slug': cap('admin.read'),
  'GET /admin/manual/search': cap('admin.read'),
  'GET /admin/runner': cap('admin.read'),
  'GET /admin/chatgpt/usage': cap('admin.read'),
  'GET /admin/chatgpt/usage/history': cap('admin.read'),

  // ── Audit ────────────────────────────────────────────────────────────────
  'GET /admin/logs': cap('audit.read'),
  'GET /admin/mcp/logs': cap('audit.read'),
  'GET /admin/memories/audit': cap('audit.read'),

  // ── Admin users ──────────────────────────────────────────────────────────
  'GET /admin/users': cap('users.read'),
  'POST /admin/users': bootstrap(
    'users.manage',
    'creates the first owner on an installation with an empty user table',
  ),
  'POST /admin/users/:id': cap('users.manage'),
  'DELETE /admin/users/:id': cap('users.manage'),
  'POST /admin/users/wipe': cap('users.manage'),

  // ── Setup wizard ─────────────────────────────────────────────────────────
  'GET /admin/setup/status': bootstrap('settings.read', 'drives the pre-owner setup screen'),
  'POST /admin/setup/owner': bootstrap('users.manage', 'claims the first owner account'),
  'GET /admin/setup/wizard': bootstrap('settings.read', 'reads wizard progress before login'),
  'POST /admin/setup/wizard': bootstrap('settings.manage', 'advances the wizard before login'),

  // ── Hosts ────────────────────────────────────────────────────────────────
  'GET /admin/hosts': cap('hosts.read'),
  'GET /admin/hosts/:id/detail': cap('hosts.read'),
  'GET /admin/hosts/insecure': cap('hosts.read'),
  'GET /admin/insecure-approvals/pending': cap('hosts.read'),

  'POST /admin/hosts/quick-register': cap('hosts.manage'),
  'POST /admin/hosts/:id/agents-version': cap('hosts.manage'),
  'POST /admin/hosts/:id/auto-update': cap('hosts.manage'),
  'POST /admin/hosts/:id/browseros-mcp': cap('hosts.manage'),
  'POST /admin/hosts/:id/claude-version': cap('hosts.manage'),
  'POST /admin/hosts/:id/clear': cap('hosts.manage'),
  'POST /admin/hosts/:id/codex-version': cap('hosts.manage'),
  'POST /admin/hosts/:id/curl-insecure': cap('hosts.manage'),
  'POST /admin/hosts/:id/installer': cap('hosts.manage'),
  'POST /admin/hosts/:id/model': cap('hosts.manage'),
  'POST /admin/hosts/:id/release-ip-binding': cap('hosts.manage'),
  'POST /admin/hosts/:id/reverse-dns': cap('hosts.manage'),
  'POST /admin/hosts/:id/roaming': cap('hosts.manage'),
  'POST /admin/hosts/:id/scaling-exempt': cap('hosts.manage'),
  'POST /admin/hosts/:id/vip': cap('hosts.manage'),

  // The four transitions that mint or revoke host credentials, plus the CLI
  // approval that registers a host. Owner and admin only — this preserves the
  // gate these five carried before the capability layer existed.
  'POST /admin/hosts/register': cap('hosts.security_transition'),
  'DELETE /admin/hosts/:id': cap('hosts.security_transition'),
  'POST /admin/hosts/:id/engines': cap('hosts.security_transition'),
  'POST /admin/hosts/:id/secure': cap('hosts.security_transition'),
  'POST /cli/auth/approve': cap('hosts.security_transition'),

  'POST /admin/hosts/:id/insecure/enable': cap('hosts.activate_insecure'),
  'POST /admin/hosts/:id/insecure/disable': cap('hosts.activate_insecure'),
  'POST /admin/hosts/insecure/extend': cap('hosts.activate_insecure'),
  'POST /admin/hosts/insecure/disable-all': cap('hosts.activate_insecure'),
  'POST /admin/insecure-approvals/:id/approve': cap('hosts.activate_insecure'),
  'POST /admin/insecure-approvals/:id/deny': cap('hosts.activate_insecure'),
  'POST /admin/insecure-approvals/:id/allow-domain': cap('hosts.activate_insecure'),
  'POST /admin/insecure-domain-allows/:id/revoke': cap('hosts.activate_insecure'),

  // ── Fleet credentials ────────────────────────────────────────────────────
  'GET /admin/hosts/:id/auth': cap('auth.read_metadata'),
  'POST /cli/auth/lookup': cap('auth.read_metadata'),
  'POST /admin/auth/upload': cap('auth.manage'),
  'POST /admin/auth/seed-command': cap('auth.manage'),
  'POST /admin/runner/run': cap('auth.manage'),
  'POST /admin/runner/run-claude': cap('auth.manage'),
  'POST /cli/auth/deny': cap('hosts.manage'),

  // ── Provider API keys ────────────────────────────────────────────────────
  'GET /admin/openai/keys': cap('auth.read_metadata'),
  'POST /admin/openai/keys': cap('keys.manage'),
  'DELETE /admin/openai/keys/:id': cap('keys.manage'),
  'POST /admin/openai/keys/:id/toggle': cap('keys.manage'),
  'GET /admin/claude/keys': cap('auth.read_metadata'),
  'POST /admin/claude/keys': cap('keys.manage'),
  'DELETE /admin/claude/keys/:id': cap('keys.manage'),
  'POST /admin/claude/keys/:id/toggle': cap('keys.manage'),

  // ── Global settings ──────────────────────────────────────────────────────
  'GET /admin/api/state': cap('settings.read'),
  'POST /admin/api/state': cap('settings.manage'),
  'GET /admin/openai/state': cap('settings.read'),
  'POST /admin/openai/state': cap('settings.manage'),
  'GET /admin/claude/state': cap('settings.read'),
  'POST /admin/claude/state': cap('settings.manage'),
  'GET /admin/claude/version': cap('settings.read'),
  'POST /admin/claude/version': cap('settings.manage'),
  'POST /admin/codex-version': cap('settings.manage'),
  'GET /admin/model-defaults/:engine': cap('settings.read'),
  'POST /admin/model-defaults/:engine': cap('settings.manage'),
  'GET /admin/agents-generation-mode': cap('settings.read'),
  'POST /admin/agents-generation-mode': cap('settings.manage'),
  'GET /admin/api-keys-in-chat': cap('settings.read'),
  'POST /admin/api-keys-in-chat': cap('settings.manage'),
  'GET /admin/auto-update': cap('settings.read'),
  'POST /admin/auto-update': cap('settings.manage'),
  // The posture itself, and the dry-run record of what `strict` would refuse.
  // Not `settings.*`: compatibility mode grants those to every role, and a
  // posture every account can change — including changing it back — is not a
  // posture. Enforced under both modes via `ALWAYS_ENFORCED`.
  'GET /admin/authorization': cap('security.manage_authorization'),
  'POST /admin/authorization': cap('security.manage_authorization'),
  'GET /admin/cdx-silent': cap('settings.read'),
  'POST /admin/cdx-silent': cap('settings.manage'),
  'GET /admin/insecure-approval': cap('settings.read'),
  'POST /admin/insecure-approval': cap('settings.manage'),
  'GET /admin/log-retention': cap('settings.read'),
  'POST /admin/log-retention': cap('settings.manage'),
  'POST /admin/prune-policy': cap('settings.manage'),
  'GET /admin/response-verbosity': cap('settings.read'),
  'POST /admin/response-verbosity': cap('settings.manage'),
  'GET /admin/quota-mode': cap('settings.read'),
  'POST /admin/quota-mode': cap('settings.manage'),
  'GET /admin/reverse-dns': cap('settings.read'),
  'POST /admin/reverse-dns': cap('settings.manage'),
  'GET /admin/scaling': cap('settings.read'),
  'POST /admin/scaling': cap('settings.manage'),
  'POST /admin/theme': cap('settings.manage'),
  'POST /admin/toasts': cap('settings.manage'),
  'POST /admin/versions/check': cap('settings.manage'),
  'POST /admin/chatgpt/usage/refresh': cap('settings.manage'),

  // ── Authored content ─────────────────────────────────────────────────────
  // `render` and `compose` are POSTs because they take a document body, but
  // they only project a preview — they stay on the read capability so a viewer
  // can see what a host would be served.
  'GET /admin/agents': cap('content.read'),
  'GET /admin/agents/render': cap('content.read'),
  'POST /admin/agents/render': cap('content.read'),
  'POST /admin/agents/compose': cap('content.read'),
  'GET /admin/agents/versions/:id': cap('content.read'),
  'POST /admin/agents/store': cap('content.manage'),
  'POST /admin/agents/serve': cap('content.manage'),
  'POST /admin/agents/revert': cap('content.manage'),
  'POST /admin/agents/retention': cap('content.manage'),
  'DELETE /admin/agents/versions/:id': cap('content.manage'),

  'GET /admin/config': cap('content.read'),
  'POST /admin/config/render': cap('content.read'),
  'POST /admin/config/store': cap('content.manage'),
  'GET /admin/claude/config': cap('content.read'),
  'POST /admin/claude/config/render': cap('content.read'),
  'POST /admin/claude/config/store': cap('content.manage'),
  'GET /admin/claude/settings': cap('content.read'),
  'POST /admin/claude/settings': cap('content.manage'),
  // Claude-native collections: subagents, slash commands, output styles.
  'GET /admin/claude/:kind': cap('content.read'),
  'GET /admin/claude/:kind/:slug': cap('content.read'),
  'POST /admin/claude/:kind/store': cap('content.manage'),
  'DELETE /admin/claude/:kind/:slug': cap('content.manage'),

  'GET /admin/skills': cap('content.read'),
  'GET /admin/skills/:slug': cap('content.read'),
  'POST /admin/skills/assist': cap('content.manage'),
  'POST /admin/skills/generate': cap('content.manage'),
  'POST /admin/skills/store': cap('content.manage'),
  'DELETE /admin/skills/:slug': cap('content.manage'),
  'GET /admin/skill-sources/mattpocock': cap('content.read'),
  'POST /admin/skill-sources/mattpocock': cap('content.manage'),
  'POST /admin/skill-sources/mattpocock/refresh': cap('content.manage'),

  'GET /admin/agent-policy-profiles': cap('content.read'),
  'GET /admin/agent-policy-profiles/enforcement': cap('content.read'),
  'POST /admin/agent-policy-profiles': cap('content.manage'),
  'POST /admin/agent-policy-profiles/assign': cap('content.manage'),
  'POST /admin/agent-policy-profiles/:id': cap('content.manage'),
  'DELETE /admin/agent-policy-profiles/:id': cap('content.manage'),
  'POST /admin/agent-policy-profiles/:id/default': cap('content.manage'),

  // ── Memory ───────────────────────────────────────────────────────────────
  'GET /admin/memories/graph': cap('memory.read'),
  'GET /admin/memories/:scope/:recordId': cap('memory.read'),
  'POST /admin/memories/:scope': cap('memory.write'),
  'PATCH /admin/memories/:scope/:recordId': cap('memory.write'),
  'DELETE /admin/memories/:scope/:recordId': cap('memory.write'),
  'POST /admin/memories/shared/:recordId/append': cap('memory.write'),
  'GET /admin/shared-memories': cap('memory.read'),
  'GET /admin/shared-memories/:slug': cap('memory.read'),
  'DELETE /admin/shared-memories/:slug': cap('memory.write'),
  'GET /admin/mcp/memories': cap('memory.read'),
  'DELETE /admin/mcp/memories/:id': cap('memory.write'),

  // ── Projects ─────────────────────────────────────────────────────────────
  'GET /admin/projects': cap('projects.read'),
  'GET /admin/projects/state': cap('projects.read'),
  'GET /admin/projects/feedback': cap('projects.read'),
  'GET /admin/projects/:slug': cap('projects.read'),
  'GET /admin/projects/:slug/changes': cap('projects.read'),
  'GET /admin/projects/:slug/feedback': cap('projects.read'),
  'GET /admin/projects/:slug/files': cap('projects.read'),
  'GET /admin/projects/:slug/notes': cap('projects.read'),
  'GET /admin/projects/:slug/todos': cap('projects.read'),
  'POST /admin/projects': cap('projects.manage'),
  'POST /admin/projects/state': cap('projects.manage'),
  'DELETE /admin/projects/:slug': cap('projects.manage'),
  'POST /admin/projects/:slug/about': cap('projects.manage'),
  'POST /admin/projects/:slug/assist': cap('projects.manage'),
  'POST /admin/projects/:slug/feedback': cap('projects.manage'),
  'POST /admin/projects/:slug/files': cap('projects.manage'),
  'DELETE /admin/projects/:slug/files/:id': cap('projects.manage'),
  'POST /admin/projects/:slug/notes': cap('projects.manage'),
  'POST /admin/projects/:slug/notes/:id': cap('projects.manage'),
  'DELETE /admin/projects/:slug/notes/:id': cap('projects.manage'),
  'POST /admin/projects/:slug/roster': cap('projects.manage'),
  'POST /admin/projects/:slug/todos': cap('projects.manage'),
  'POST /admin/projects/:slug/todos/:id': cap('projects.manage'),
  'DELETE /admin/projects/:slug/todos/:id': cap('projects.manage'),
  'POST /admin/projects/:slug/todos/:id/done': cap('projects.manage'),
  'POST /admin/projects/:slug/todos/:id/undone': cap('projects.manage'),

  // ── Fleet secrets ────────────────────────────────────────────────────────
  'GET /admin/secrets': cap('secrets.read_metadata'),
  'GET /admin/secrets/state': cap('secrets.read_metadata'),
  'GET /admin/secrets/:id': cap('secrets.read_metadata'),
  'POST /admin/secrets/:id/reveal': cap('secrets.reveal'),
  'POST /admin/secrets': cap('secrets.manage'),
  'PATCH /admin/secrets/:id': cap('secrets.manage'),
  'DELETE /admin/secrets/:id': cap('secrets.manage'),
  'POST /admin/secrets/state': cap('secrets.manage'),

  // ── Agent portal ─────────────────────────────────────────────────────────
  'GET /admin/agent-portal/state': cap('agent_portal.read'),
  'GET /admin/agent-portal/users': cap('agent_portal.read'),
  'GET /admin/agent-portal/users/:id/link': cap('agent_portal.reveal_link'),
  'POST /admin/agent-portal/state': cap('agent_portal.manage'),
  'POST /admin/agent-portal/users': cap('agent_portal.manage'),
  'POST /admin/agent-portal/users/:id': cap('agent_portal.manage'),
  'DELETE /admin/agent-portal/users/:id': cap('agent_portal.manage'),
  'POST /admin/agent-portal/users/:id/enabled': cap('agent_portal.manage'),
  'POST /admin/agent-portal/users/:id/rotate': cap('agent_portal.manage'),

  // ── Agent messaging ──────────────────────────────────────────────────────
  'GET /admin/agent-messaging': cap('agent_messaging.read'),
  'GET /admin/agent-messaging/state': cap('agent_messaging.read'),
  'GET /admin/agent-messaging/addresses': cap('agent_messaging.read'),
  'GET /admin/agent-messaging/conversations': cap('agent_messaging.read'),
  'GET /admin/agent-messaging/messages': cap('agent_messaging.read'),
  'POST /admin/agent-messaging/messages/:id/reveal': cap('agent_messaging.reveal_content'),
  'POST /admin/agent-messaging/state': cap('agent_messaging.manage'),
  'PATCH /admin/agent-messaging/addresses/:id': cap('agent_messaging.manage'),
  'POST /admin/agent-messaging/addresses/:id/enabled': cap('agent_messaging.manage'),
  'POST /admin/agent-messaging/conversations/:id/cancel': cap('agent_messaging.manage'),
  'POST /admin/agent-messaging/messages/:id/redrive': cap('agent_messaging.manage'),
};

/** Path prefixes this inventory is responsible for. */
export const GOVERNED_PREFIXES = ['/admin/', '/cli/auth/'] as const;

/**
 * Whether a registered route pattern must carry an inventory entry. `/admin`
 * and `/cli/auth` themselves (no trailing segment) are included so a route
 * mounted exactly at a prefix cannot slip through.
 */
export function isGovernedRoute(url: string): boolean {
  return GOVERNED_PREFIXES.some((prefix) => url === prefix.slice(0, -1) || url.startsWith(prefix));
}

/**
 * The inventory key for a registered route. `HEAD` resolves to its `GET` entry
 * because Fastify derives head routes from get routes and never lets them
 * diverge.
 */
export function routeKey(method: string, url: string): string {
  return `${method === 'HEAD' ? 'GET' : method} ${url}`;
}

export function guardForRoute(method: string, url: string): RouteGuard | undefined {
  return ROUTE_CAPABILITIES[routeKey(method, url)];
}
