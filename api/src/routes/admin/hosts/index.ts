/**
 * /admin/hosts/* + /admin/insecure-{approvals,domain-allows}/* routes.
 *
 * Phase 2.3 of BACKEND-redo (Node/Fastify replacement for the PHP
 * AdminHostController).
 *
 * Every route attaches `app.requireAdmin` as the preHandler. Mutation routes
 * write an `admin_events` row (audit-first) and then publish the matching WS
 * event via the in-process publisher. The service layer (`host-management`
 * and `insecure-window-admin`) owns the actual DB work.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ValidationError } from '../../../http/errors.js';
import { makeAdminEventsWriter } from '../../../services/admin-events-writer.js';
import {
  HostManagementService,
  parseEnginesInput,
  MIN_INSECURE_WINDOW_MINUTES,
  MAX_INSECURE_WINDOW_MINUTES,
} from '../../../services/host-management.js';
import { InsecureWindowAdminService } from '../../../services/insecure-window-admin.js';
import {
  createRunnerValidationService,
  type RunnerValidationService,
} from '../../../services/runner-validation.js';
import { parseReverseDnsModeInput, tinyintToModeString } from '../../../services/reverse-dns.js';
import { hostEnginesList } from '../../../services/host-engine-policy.js';
import { hostAuthDigests, type Host } from '../../../db/schema.js';
import { ENGINE_CODEX, ENGINE_CLAUDE, isEngine, type Engine } from '../../../util/engine.js';

// ────────────────────────────────────────────────────────────────────────────
// Zod schemas
// ────────────────────────────────────────────────────────────────────────────

const booleanish = z.union([z.boolean(), z.number(), z.string()]).transform((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = v.toLowerCase().trim();
  if (['1', 'true', 'yes', 'on', 't', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'f', 'n'].includes(s)) return false;
  throw new Error(`not a boolean: ${v}`);
});

const optionalBooleanishOrNull = z.union([z.boolean(), z.number(), z.string(), z.null()]).transform((v) => {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = v.toLowerCase().trim();
  if (['1', 'true', 'yes', 'on', 't', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'f', 'n'].includes(s)) return false;
  throw new Error(`not a boolean or null: ${v}`);
});

const durationMinutesSchema = z
  .union([z.string(), z.number()])
  .transform((v) => {
    const n = typeof v === 'number' ? v : Number.parseInt(String(v).trim(), 10);
    if (!Number.isFinite(n)) {
      throw new Error('duration_minutes must be an integer');
    }
    return n;
  })
  .refine((n) => n >= MIN_INSECURE_WINDOW_MINUTES && n <= MAX_INSECURE_WINDOW_MINUTES, {
    message: `duration_minutes must be between ${MIN_INSECURE_WINDOW_MINUTES} and ${MAX_INSECURE_WINDOW_MINUTES}`,
  })
  .optional()
  .nullable();

const enginesSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((raw): Engine[] => {
    const parts: string[] = Array.isArray(raw) ? raw : raw.split(',');
    const out: Engine[] = [];
    for (const p of parts) {
      const t = String(p).trim().toLowerCase();
      if (t === ENGINE_CODEX || t === ENGINE_CLAUDE) {
        if (!out.includes(t as Engine)) out.push(t as Engine);
      }
    }
    return out;
  })
  .optional();

const registerSchema = z.object({
  fqdn: z.string().min(1, 'fqdn is required'),
  secure: booleanish.optional(),
  vip: booleanish.optional(),
  temporary: booleanish.optional(),
  curl_insecure: booleanish.optional(),
  reverse_dns_mode: z.union([z.string(), z.null()]).optional(),
  duration_minutes: durationMinutesSchema,
  engines: enginesSchema,
});

const quickRegisterSchema = z.object({
  engines: enginesSchema,
  duration_minutes: durationMinutesSchema,
});

const allowSchema = z.object({ allow: booleanish });
const secureSchema = z.object({
  secure: booleanish,
  grace_minutes: z.union([z.number(), z.string()]).optional().nullable(),
});
const vipSchema = z.object({ vip: booleanish });
const scalingExemptSchema = z.object({ scaling_exempt: booleanish });
const browserOsMcpSchema = z.object({ browseros_mcp: booleanish });
const autoUpdateSchema = z.object({ override: optionalBooleanishOrNull.optional() });
const insecureEnableSchema = z.object({ duration_minutes: durationMinutesSchema });
const reverseDnsSchema = z.object({ mode: z.string() });

const modelOverridesSchema = z
  .object({
    model_override: z.union([z.string(), z.null()]).optional(),
    reasoning_effort_override: z.union([z.string(), z.null()]).optional(),
    claude_model_override: z.union([z.string(), z.null()]).optional(),
  })
  .strict();

const versionSelectionSchema = z.object({
  selection: z.union([z.string(), z.null()]).optional(),
  client_version_override: z.union([z.string(), z.null()]).optional(),
  claude_client_version_override: z.union([z.string(), z.null()]).optional(),
  agents_document_id_override: z.union([z.string(), z.number(), z.null()]).optional(),
});

const allowDomainSchema = z.object({
  domain: z.union([z.string(), z.null()]).optional(),
  duration_minutes: durationMinutesSchema,
});

const approveSchema = z.object({
  duration_minutes: durationMinutesSchema,
});

const mintInstallerSchema = z.object({
  engines: enginesSchema,
  curl_insecure: booleanish.optional(),
});

const setEnginesSchema = z.object({
  engines: enginesSchema,
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function parseId(raw: unknown, name = 'id'): number {
  const s = String(raw ?? '');
  if (!/^\d+$/.test(s)) throw new ValidationError(`${name} must be numeric`, { param: name });
  return Number.parseInt(s, 10);
}

function parseIncludeBody(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  const s = String(raw).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function hostToWire(h: Host): Record<string, unknown> {
  return {
    id: h.id,
    fqdn: h.fqdn,
    status: h.status,
    secure: h.secure === 1,
    vip: h.vip === 1,
    allow_roaming_ips: h.allowRoamingIps === 1,
    scaling_exempt: h.scalingExempt === 1,
    curl_insecure: h.curlInsecure === 1,
    browseros_mcp_enabled: h.browserosMcpEnabled === 1,
    auto_update_override:
      h.autoUpdateOverride === null || h.autoUpdateOverride === undefined ? null : h.autoUpdateOverride === 1,
    reverse_dns_mode: tinyintToModeString(h.reverseDnsMode ?? null),
    model_override: h.modelOverride,
    reasoning_effort_override: h.reasoningEffortOverride,
    claude_model_override: h.claudeModelOverride,
    client_version_override: h.clientVersionOverride,
    claude_client_version_override: h.claudeClientVersionOverride,
    agents_document_id_override: h.agentsDocumentIdOverride,
    insecure_enabled_until:
      h.insecureEnabledUntil instanceof Date ? h.insecureEnabledUntil.toISOString() : h.insecureEnabledUntil,
    insecure_grace_until:
      h.insecureGraceUntil instanceof Date ? h.insecureGraceUntil.toISOString() : h.insecureGraceUntil,
    insecure_window_minutes: h.insecureWindowMinutes,
    engines: h.engines,
    engines_list: hostEnginesList(h.engines),
    expires_at: h.expiresAt,
    last_refresh: h.lastRefresh,
    claude_last_refresh: h.claudeLastRefresh,
    updated_at: h.updatedAt,
  };
}

function parseZod<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const param = first && first.path[0] !== undefined ? String(first.path[0]) : undefined;
    throw new ValidationError(first?.message ?? 'Invalid request', { param });
  }
  return parsed.data;
}

// ────────────────────────────────────────────────────────────────────────────
// Registration
// ────────────────────────────────────────────────────────────────────────────

export interface AdminHostAuthView {
  canonical_last_refresh: string | null;
  canonical_digest: string | null;
  recent_digests: string[];
  auth: Record<string, unknown> | null;
}

export interface AdminHostRoutesOverrides {
  hostService?: HostManagementService;
  insecure?: InsecureWindowAdminService;
  authView?: (host: Host, engine: Engine, includeBody: boolean) => Promise<AdminHostAuthView>;
}

export async function registerAdminHostsRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  overrides: AdminHostRoutesOverrides = {},
): Promise<void> {
  const events = makeAdminEventsWriter(ctx.db);
  const hostService =
    overrides.hostService ??
    new HostManagementService({
      db: ctx.db,
      env: ctx.env,
      keyring: ctx.keyring,
      events,
    });
  const insecure = overrides.insecure ?? new InsecureWindowAdminService({ db: ctx.db, env: ctx.env, events });
  const runnerValidation: RunnerValidationService = createRunnerValidationService({
    db: ctx.db,
    keyring: ctx.keyring,
  });
  const authView =
    overrides.authView ??
    (async (host: Host, engine: Engine, includeBody: boolean): Promise<AdminHostAuthView> => {
      const canonicalRow = await runnerValidation.resolveCanonicalPayload(engine);
      const validated = runnerValidation.validateCanonicalPayload(canonicalRow);
      const digests = await ctx.db
        .select({ digest: hostAuthDigests.digest })
        .from(hostAuthDigests)
        .where(and(eq(hostAuthDigests.hostId, host.id), eq(hostAuthDigests.engine, engine)))
        .orderBy(desc(hostAuthDigests.lastSeen))
        .limit(3);
      const engineLastRefresh =
        engine === ENGINE_CLAUDE ? host.claudeLastRefresh ?? null : host.lastRefresh ?? null;
      const engineDigest =
        engine === ENGINE_CLAUDE ? host.claudeAuthDigest ?? null : host.authDigest ?? null;
      return {
        canonical_last_refresh: validated?.last_refresh ?? engineLastRefresh,
        canonical_digest: validated?.digest ?? engineDigest,
        recent_digests: digests.map((d) => d.digest),
        auth: includeBody ? validated?.auth ?? null : null,
      };
    });

  // ─── #1 POST /admin/hosts/register ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/register',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const body = parseZod(registerSchema, req.body);
      let mode: 'global' | 'enabled' | 'disabled' | null = null;
      if (body.reverse_dns_mode !== undefined && body.reverse_dns_mode !== null) {
        const m = parseReverseDnsModeInput(body.reverse_dns_mode);
        if (m === null) {
          throw new ValidationError('reverse_dns_mode must be one of: global, enabled, disabled', {
            param: 'reverse_dns_mode',
          });
        }
        mode = m;
      }
      // Leave secure/engines undefined when the caller omits them so
      // HostManagementService.register() can preserve an existing host's
      // current values instead of resetting to the global defaults (only
      // applies to brand-new hosts).
      const { host, apiKeyPlain, installer } = await hostService.register({
        fqdn: body.fqdn,
        secure: body.secure,
        vip: body.vip,
        temporary: body.temporary,
        curl_insecure: body.curl_insecure,
        reverse_dns_mode: mode,
        duration_minutes: body.duration_minutes ?? null,
        engines: body.engines,
      });
      return {
        host: { ...hostToWire(host), api_key: apiKeyPlain },
        installer,
      };
    },
  });

  // ─── #2 POST /admin/hosts/quick-register ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/quick-register',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const body = parseZod(quickRegisterSchema, req.body);
      const engines =
        body.engines && body.engines.length
          ? body.engines
          : parseEnginesInput(ctx.env.DEFAULT_HOST_ENGINES, [ENGINE_CODEX]);
      if (!engines.length) {
        throw new ValidationError('engines must contain at least one of: codex, claude', {
          param: 'engines',
        });
      }
      const { host, apiKeyPlain, installer } = await hostService.quickRegister({
        engines,
        duration_minutes: body.duration_minutes ?? null,
      });
      return {
        host: { ...hostToWire(host), api_key: apiKeyPlain },
        installer,
      };
    },
  });

  // ─── #3 GET /admin/hosts/:id/auth ───
  app.route({
    method: 'GET',
    url: '/admin/hosts/:id/auth',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const query = (req.query ?? {}) as { engine?: string; include_body?: string };
      const engine: Engine = isEngine(query.engine) ? query.engine : ENGINE_CODEX;
      const includeBody = parseIncludeBody(query.include_body);
      const host = await hostService.requireById(id);
      const view = await authView(host, engine, includeBody);
      return {
        host: hostToWire(host),
        engine,
        canonical_last_refresh: view.canonical_last_refresh,
        canonical_digest: view.canonical_digest,
        recent_digests: view.recent_digests,
        auth: view.auth,
        api_calls: host.apiCalls,
      };
    },
  });

  // ─── #4 POST /admin/hosts/:id/installer ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/installer',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(mintInstallerSchema, req.body ?? {});
      const requestedEngines = body.engines && body.engines.length ? body.engines : undefined;
      const { host, installer } = await hostService.mintInstaller(id, requestedEngines, {
        curlInsecure: body.curl_insecure,
      });
      return {
        host: hostToWire(host),
        installer,
      };
    },
  });

  // ─── #5 DELETE /admin/hosts/:id ───
  app.route({
    method: 'DELETE',
    url: '/admin/hosts/:id',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      await hostService.delete(id);
      return { deleted: id };
    },
  });

  // ─── #5b POST /admin/hosts/:id/engines ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/engines',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(setEnginesSchema, req.body ?? {});
      if (!body.engines || body.engines.length === 0) {
        throw new ValidationError('engines must contain at least one of: codex, claude', {
          param: 'engines',
        });
      }
      const host = await hostService.setEngines(id, body.engines);
      return { host: hostToWire(host) };
    },
  });

  // ─── #6 POST /admin/hosts/:id/clear ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/clear',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const { host } = await hostService.clear(id);
      return { host: hostToWire(host) };
    },
  });

  // ─── #6b POST /admin/hosts/:id/release-ip-binding ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/release-ip-binding',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const host = await hostService.releaseIpBinding(id);
      return { host: hostToWire(host) };
    },
  });

  // ─── #7 POST /admin/hosts/:id/roaming ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/roaming',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(allowSchema, req.body);
      const host = await hostService.setRoaming(id, body.allow);
      return { host: hostToWire(host) };
    },
  });

  // ─── #8 POST /admin/hosts/:id/secure ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/secure',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(secureSchema, req.body);
      let graceMinutes: number | null = null;
      if (body.grace_minutes !== undefined && body.grace_minutes !== null) {
        const n =
          typeof body.grace_minutes === 'number'
            ? body.grace_minutes
            : Number.parseInt(String(body.grace_minutes), 10);
        if (!Number.isFinite(n) || n < 0) {
          throw new ValidationError('grace_minutes must be a non-negative integer', {
            param: 'grace_minutes',
          });
        }
        graceMinutes = n;
      }
      const host = await hostService.setSecure(id, body.secure, graceMinutes);
      return { host: hostToWire(host) };
    },
  });

  // ─── #9 POST /admin/hosts/:id/vip ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/vip',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(vipSchema, req.body);
      const host = await hostService.setVip(id, body.vip);
      return { host: hostToWire(host) };
    },
  });

  // ─── #10 POST /admin/hosts/:id/scaling-exempt ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/scaling-exempt',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(scalingExemptSchema, req.body);
      const host = await hostService.setScalingExempt(id, body.scaling_exempt);
      return { host: hostToWire(host) };
    },
  });

  // ─── #11 POST /admin/hosts/:id/auto-update ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/auto-update',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(autoUpdateSchema, req.body);
      const override = body.override === undefined ? null : (body.override as boolean | null);
      const host = await hostService.setAutoUpdateOverride(id, override);
      return { host: hostToWire(host) };
    },
  });

  // ─── #12 POST /admin/hosts/:id/insecure/enable ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/insecure/enable',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(insecureEnableSchema, req.body);
      const host = await insecure.enable(id, body.duration_minutes ?? null);
      return { host: hostToWire(host) };
    },
  });

  // ─── #13 POST /admin/hosts/:id/insecure/disable ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/insecure/disable',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const host = await insecure.disable(id);
      return { host: hostToWire(host) };
    },
  });

  // ─── #14 GET /admin/insecure-approvals/pending ───
  app.route({
    method: 'GET',
    url: '/admin/insecure-approvals/pending',
    preHandler: [app.requireAdmin],
    handler: async () => {
      const rows = await insecure.listPending();
      return { requests: rows };
    },
  });

  // ─── #15 POST /admin/insecure-approvals/:id/allow-domain ───
  app.route({
    method: 'POST',
    url: '/admin/insecure-approvals/:id/allow-domain',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(allowDomainSchema, req.body);
      const result = await insecure.allowDomain(id, body.domain ?? null, body.duration_minutes ?? null);
      return {
        request: { id: result.requestId, status: 'approved' },
        host: hostToWire(result.host),
        domain: {
          id: result.domain.id,
          domain: result.domain.domain,
          enabled_until: result.domain.enabled_until,
          window_minutes: result.domain.window_minutes,
        },
      };
    },
  });

  // ─── #16 POST /admin/insecure-approvals/:id/approve ───
  app.route({
    method: 'POST',
    url: '/admin/insecure-approvals/:id/approve',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(approveSchema, req.body);
      const result = await insecure.approve(id, body.duration_minutes ?? null);
      return {
        request: { id: result.requestId, status: 'approved' },
        host: hostToWire(result.host),
      };
    },
  });

  // ─── #17 POST /admin/insecure-approvals/:id/deny ───
  app.route({
    method: 'POST',
    url: '/admin/insecure-approvals/:id/deny',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const result = await insecure.deny(id);
      return {
        request: { id: result.requestId, status: 'denied' },
      };
    },
  });

  // ─── #18 POST /admin/insecure-domain-allows/:id/revoke ───
  app.route({
    method: 'POST',
    url: '/admin/insecure-domain-allows/:id/revoke',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const allow = await insecure.revokeDomain(id);
      return {
        domain: {
          id: allow.id,
          domain: allow.domain,
          revoked_at: allow.revoked_at,
        },
      };
    },
  });

  // ─── #19 POST /admin/hosts/:id/curl-insecure ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/curl-insecure',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(allowSchema, req.body);
      const host = await hostService.setCurlInsecure(id, body.allow);
      return { host: hostToWire(host) };
    },
  });

  // ─── #20 POST /admin/hosts/:id/browseros-mcp ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/browseros-mcp',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(browserOsMcpSchema, req.body);
      const host = await hostService.setBrowserOsMcp(id, body.browseros_mcp);
      return { host: hostToWire(host) };
    },
  });

  // ─── #21 POST /admin/hosts/:id/reverse-dns ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/reverse-dns',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(reverseDnsSchema, req.body);
      const mode = parseReverseDnsModeInput(body.mode);
      if (mode === null) {
        throw new ValidationError('mode must be one of: global, enabled, disabled', {
          param: 'mode',
        });
      }
      const host = await hostService.setReverseDnsMode(id, mode);
      return { host: hostToWire(host) };
    },
  });

  // ─── #21 POST /admin/hosts/:id/model ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/model',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(modelOverridesSchema, req.body);
      const includesClaude = Object.prototype.hasOwnProperty.call(
        (req.body ?? {}) as object,
        'claude_model_override',
      );
      const host = await hostService.setModelOverrides(id, {
        model_override: body.model_override === undefined ? undefined : body.model_override,
        reasoning_effort_override:
          body.reasoning_effort_override === undefined ? undefined : body.reasoning_effort_override,
        claude_model_override:
          body.claude_model_override === undefined ? undefined : body.claude_model_override,
        includeClaudeOverride: includesClaude,
      });
      return { host: hostToWire(host) };
    },
  });

  // ─── #22 POST /admin/hosts/:id/codex-version ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/codex-version',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(versionSelectionSchema, req.body);
      const raw = (body.selection ?? body.client_version_override ?? null) as string | null;
      const sel = typeof raw === 'string' ? raw.trim() : null;
      const isGlobal =
        sel === null || sel === '' || ['global', 'fleet', 'default'].includes(sel.toLowerCase());
      const host = await hostService.setCodexVersionOverride(id, isGlobal ? null : sel);
      return { host: hostToWire(host) };
    },
  });

  // ─── #23 POST /admin/hosts/:id/claude-version ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/claude-version',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(versionSelectionSchema, req.body);
      const raw = (body.selection ?? body.claude_client_version_override ?? null) as string | null;
      const sel = typeof raw === 'string' ? raw.trim() : null;
      const isGlobal =
        sel === null || sel === '' || ['global', 'fleet', 'default'].includes(sel.toLowerCase());
      const host = await hostService.setClaudeVersionOverride(id, isGlobal ? null : sel);
      return { host: hostToWire(host) };
    },
  });

  // ─── #24 POST /admin/hosts/:id/agents-version ───
  app.route({
    method: 'POST',
    url: '/admin/hosts/:id/agents-version',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const body = parseZod(versionSelectionSchema, req.body);
      const raw = body.selection ?? body.agents_document_id_override ?? null;
      let selection: string | number | null = null;
      if (typeof raw === 'string') {
        const t = raw.trim().toLowerCase();
        if (t === '' || t === 'global' || t === 'fleet' || t === 'default') selection = null;
        else selection = raw.trim();
      } else if (typeof raw === 'number') {
        selection = raw;
      }
      const host = await hostService.setAgentsDocumentOverride(id, selection);
      return { host: hostToWire(host) };
    },
  });
}
