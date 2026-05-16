/**
 * /admin/* settings endpoints. Each pair (GET + POST) reads and writes one
 * setting from the `versions` table via SettingsService. Every mutation
 * publishes a `settings.changed` WS event (via SettingsService) and writes an
 * `admin.<setting>` row to `logs`.
 *
 * The kill-switch `/admin/api/state GET` is intentionally NOT gated by the
 * kill-switch itself — it must remain reachable so admins can flip it back
 * even after enabling it. Authentication (requireAdmin) still applies.
 */

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { SettingsService } from '../../../services/settings.js';
import {
  ClientVersionsService,
  isSemanticVersion,
  normalizeVersion,
} from '../../../services/client-versions.js';
import { UsageScalingService } from '../../../services/usage-scaling.js';
import { ClaudeUsageService } from '../../../services/claude-usage.js';
import { ValidationError } from '../../../http/errors.js';
import { ok } from '../../../http/reply.js';
import { logs } from '../../../db/schema.js';
import { nowIso } from '../../../util/timestamp.js';

const ADMIN_THEMES = ['auto', 'auto-pink', 'light', 'dark', 'bright-pink', 'dark-pink'] as const;
type AdminTheme = (typeof ADMIN_THEMES)[number];

function normalizeTheme(input: unknown): AdminTheme | null {
  if (typeof input !== 'string') return null;
  const lower = input.trim().toLowerCase();
  return (ADMIN_THEMES as readonly string[]).includes(lower) ? (lower as AdminTheme) : null;
}

function normalizeBool(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function recordLog(
  ctx: RouteContext,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.db.insert(logs).values({
      hostId: null,
      action,
      details: JSON.stringify(details),
      createdAt: nowIso(),
    });
  } catch {
    /* logging is best-effort */
  }
}

export async function registerAdminSettingsRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const settings = new SettingsService(ctx.db);
  const clientVersions = new ClientVersionsService(settings, app.log);
  const scaling = new UsageScalingService(settings);
  const claudeUsage = new ClaudeUsageService(ctx.db);

  // ── api/state — kill switch (GET allowed even when killed) ────────────────
  app.get('/admin/api/state', { preHandler: app.requireAdmin }, async () => {
    return ok({ disabled: await settings.getFlag('api_disabled', false) });
  });
  app.post('/admin/api/state', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { disabled?: unknown };
    const disabled = normalizeBool(body.disabled);
    if (disabled === null) throw new ValidationError('disabled must be boolean', { param: 'disabled' });
    await settings.setFlag('api_disabled', disabled);
    await recordLog(ctx, 'admin.api.state', { disabled });
    return ok({ disabled });
  });

  // ── cdx-silent ────────────────────────────────────────────────────────────
  app.get('/admin/cdx-silent', { preHandler: app.requireAdmin }, async () => {
    return ok({ silent: await settings.getFlag('cdx_silent', false) });
  });
  app.post('/admin/cdx-silent', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { silent?: unknown };
    const silent = normalizeBool(body.silent);
    if (silent === null) throw new ValidationError('silent must be boolean', { param: 'silent' });
    await settings.setFlag('cdx_silent', silent);
    await recordLog(ctx, 'admin.cdx_silent', { silent });
    return ok({ silent });
  });

  // ── theme ─────────────────────────────────────────────────────────────────
  app.get('/admin/theme', { preHandler: app.requireAdmin }, async () => {
    const raw = await settings.getString('admin_theme', 'auto');
    return ok({ theme: normalizeTheme(raw) ?? 'auto' });
  });
  app.post('/admin/theme', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { theme?: unknown };
    const theme = normalizeTheme(body.theme);
    if (!theme) {
      throw new ValidationError(`theme must be one of: ${ADMIN_THEMES.join(', ')}`, { param: 'theme' });
    }
    await settings.set('admin_theme', theme);
    await recordLog(ctx, 'admin.theme', { theme });
    return ok({ theme });
  });

  // ── reverse-dns ───────────────────────────────────────────────────────────
  app.get('/admin/reverse-dns', { preHandler: app.requireAdmin }, async () => {
    return ok({ enabled: await settings.getFlag('reverse_dns_enabled', false) });
  });
  app.post('/admin/reverse-dns', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { enabled?: unknown };
    const enabled = normalizeBool(body.enabled);
    if (enabled === null) throw new ValidationError('enabled must be boolean', { param: 'enabled' });
    await settings.setFlag('reverse_dns_enabled', enabled);
    await recordLog(ctx, 'admin.reverse_dns', { enabled });
    return ok({ enabled });
  });

  // ── auto-update ───────────────────────────────────────────────────────────
  app.get('/admin/auto-update', { preHandler: app.requireAdmin }, async () => {
    return ok({ enabled: await settings.getFlag('auto_update_enabled', false) });
  });
  app.post('/admin/auto-update', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { enabled?: unknown };
    const enabled = normalizeBool(body.enabled);
    if (enabled === null) throw new ValidationError('enabled must be boolean', { param: 'enabled' });
    await settings.setFlag('auto_update_enabled', enabled);
    await recordLog(ctx, 'admin.auto_update', { enabled });
    return ok({ enabled });
  });

  // ── insecure-approval ─────────────────────────────────────────────────────
  app.get('/admin/insecure-approval', { preHandler: app.requireAdmin }, async () => {
    return ok({ enabled: await settings.getFlag('insecure_approval_enabled', false) });
  });
  app.post('/admin/insecure-approval', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { enabled?: unknown };
    const enabled = normalizeBool(body.enabled);
    if (enabled === null) throw new ValidationError('enabled must be boolean', { param: 'enabled' });
    await settings.setFlag('insecure_approval_enabled', enabled);
    await recordLog(ctx, 'admin.insecure_approval', { enabled });
    return ok({ enabled });
  });

  // ── codex-version ─────────────────────────────────────────────────────────
  app.post('/admin/codex-version', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { selection?: unknown };
    if (typeof body.selection !== 'string' || body.selection.trim() === '') {
      throw new ValidationError('selection must be one of: latest, or a version like 0.125.0', {
        param: 'selection',
      });
    }
    const selection = body.selection.trim();
    const lower = selection.toLowerCase();
    let logSelection: string = 'latest';
    let lock: { locked_version: string | null; locked_at: string | null };
    if (lower === 'latest' || lower === 'auto') {
      lock = await clientVersions.setCodexVersionLock(null);
      void clientVersions.availableClientVersion(true);
    } else {
      const normalized = normalizeVersion(selection);
      if (!normalized || !isSemanticVersion(normalized)) {
        throw new ValidationError('selection must be a semantic version like 0.125.0', {
          param: 'selection',
        });
      }
      lock = await clientVersions.setCodexVersionLock(normalized);
      logSelection = normalized;
    }
    await recordLog(ctx, 'admin.codex_version', {
      selection: logSelection,
      locked_version: lock.locked_version,
    });
    return ok(lock);
  });

  // ── quota-mode ────────────────────────────────────────────────────────────
  app.get('/admin/quota-mode', { preHandler: app.requireAdmin }, async () => {
    const hardFail = await settings.getFlag('quota_hard_fail', true);
    const limitRaw = await settings.getInt('quota_limit_percent', 95);
    const limitPercent = clampInt(limitRaw, 50, 100, 95);
    const partitionRaw = (await settings.getString('quota_week_partition', 'off')) ?? 'off';
    const partition = ['off', '5', '7'].includes(partitionRaw) ? partitionRaw : 'off';
    return ok({ hard_fail: hardFail, limit_percent: limitPercent, week_partition: partition });
  });
  app.post('/admin/quota-mode', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as {
      hard_fail?: unknown;
      limit_percent?: unknown;
      week_partition?: unknown;
    };
    const hardFail = normalizeBool(body.hard_fail);
    if (hardFail === null) throw new ValidationError('hard_fail must be boolean', { param: 'hard_fail' });

    let limitPercent: number;
    if (body.limit_percent === undefined || body.limit_percent === null) {
      limitPercent = clampInt(await settings.getInt('quota_limit_percent', 95), 50, 100, 95);
    } else {
      const n = Number(body.limit_percent);
      if (!Number.isFinite(n) || n < 50 || n > 100) {
        throw new ValidationError('limit_percent must be between 50 and 100', {
          param: 'limit_percent',
        });
      }
      limitPercent = Math.trunc(n);
    }

    let weekPartition: string;
    if (body.week_partition === undefined || body.week_partition === null) {
      weekPartition = (await settings.getString('quota_week_partition', 'off')) ?? 'off';
    } else {
      const s = String(body.week_partition).trim().toLowerCase();
      if (!['off', '5', '7'].includes(s)) {
        throw new ValidationError('week_partition must be one of: off, 5, 7', {
          param: 'week_partition',
        });
      }
      weekPartition = s;
    }

    await settings.setFlag('quota_hard_fail', hardFail);
    await settings.setInt('quota_limit_percent', limitPercent);
    await settings.set('quota_week_partition', weekPartition);
    await recordLog(ctx, 'admin.quota_mode', {
      hard_fail: hardFail,
      limit_percent: limitPercent,
      week_partition: weekPartition,
    });
    return ok({ hard_fail: hardFail, limit_percent: limitPercent, week_partition: weekPartition });
  });

  // ── prune-policy ──────────────────────────────────────────────────────────
  app.post('/admin/prune-policy', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { inactivity_days?: unknown };
    const n = Number(body.inactivity_days);
    if (!Number.isFinite(n)) {
      throw new ValidationError('inactivity_days must be an integer between 0 and 60', {
        param: 'inactivity_days',
      });
    }
    const days = Math.max(0, Math.min(60, Math.trunc(n)));
    await settings.setInt('inactivity_window_days', days);
    await recordLog(ctx, 'admin.prune_policy', { inactivity_window_days: days });
    return ok({ inactivity_window_days: days });
  });

  // ── log-retention ─────────────────────────────────────────────────────────
  app.get('/admin/log-retention', { preHandler: app.requireAdmin }, async () => {
    const [enabled, dl, dm, de, dgs] = await Promise.all([
      settings.getFlag('log_retention_enabled', false),
      settings.getInt('log_retention_days_logs', 90),
      settings.getInt('log_retention_days_mcp', 90),
      settings.getInt('log_retention_days_events', 30),
      settings.getInt('log_retention_days_graph_stats', 180),
    ]);
    return ok({
      enabled,
      days_logs: clampInt(dl, 1, 365, 90),
      days_mcp: clampInt(dm, 1, 365, 90),
      days_events: clampInt(de, 1, 365, 30),
      days_graph_stats: clampInt(dgs, 1, 365, 180),
    });
  });
  app.post('/admin/log-retention', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as {
      enabled?: unknown;
      days_logs?: unknown;
      days_mcp?: unknown;
      days_events?: unknown;
      days_graph_stats?: unknown;
    };
    const enabled = normalizeBool(body.enabled);
    if (enabled === null) throw new ValidationError('enabled must be boolean', { param: 'enabled' });
    const daysLogs = clampInt(body.days_logs, 1, 365, 90);
    const daysMcp = clampInt(body.days_mcp, 1, 365, 90);
    const daysEvents = clampInt(body.days_events, 1, 365, 30);
    const daysGraphStats = clampInt(body.days_graph_stats, 1, 365, 180);

    await settings.setFlag('log_retention_enabled', enabled);
    await settings.setInt('log_retention_days_logs', daysLogs);
    await settings.setInt('log_retention_days_mcp', daysMcp);
    await settings.setInt('log_retention_days_events', daysEvents);
    await settings.setInt('log_retention_days_graph_stats', daysGraphStats);
    await recordLog(ctx, 'admin.log_retention', {
      enabled,
      days_logs: daysLogs,
      days_mcp: daysMcp,
      days_events: daysEvents,
      days_graph_stats: daysGraphStats,
    });
    return ok({
      enabled,
      days_logs: daysLogs,
      days_mcp: daysMcp,
      days_events: daysEvents,
      days_graph_stats: daysGraphStats,
    });
  });

  // ── scaling ───────────────────────────────────────────────────────────────
  app.get('/admin/scaling', { preHandler: app.requireAdmin }, async () => {
    return ok(await scaling.currentStatus());
  });
  app.post('/admin/scaling', { preHandler: app.requireAdmin }, async (req) => {
    const errors = await scaling.storeRules(req.body);
    if (errors.length) {
      throw new ValidationError('Validation failed', { extra: { errors } });
    }
    await recordLog(ctx, 'admin.scaling', { saved: true });
    return ok(await scaling.currentStatus());
  });

  // ── versions/check ────────────────────────────────────────────────────────
  app.post('/admin/versions/check', { preHandler: app.requireAdmin }, async () => {
    const [available, summary] = await Promise.all([
      clientVersions.availableClientVersion(true),
      clientVersions.versionSummary(),
    ]);
    return ok({ available_client: available, versions: summary });
  });

  // ── claude/version ────────────────────────────────────────────────────────
  app.get('/admin/claude/version', { preHandler: app.requireAdmin }, async () => {
    const [version, locked, updatedAt] = await Promise.all([
      settings.getString('claude_fleet_version'),
      settings.getFlag('claude_version_locked', false),
      settings.getString('claude_fleet_version_updated_at'),
    ]);
    return ok({ version, locked, updated_at: updatedAt });
  });
  app.post('/admin/claude/version', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { version?: unknown; locked?: unknown };
    const version = typeof body.version === 'string' ? body.version.trim() : '';
    const locked = normalizeBool(body.locked) ?? false;
    await settings.set('claude_fleet_version', version);
    await settings.setFlag('claude_version_locked', locked);
    await settings.set('claude_fleet_version_updated_at', nowIso());
    await recordLog(ctx, 'admin.claude_version', { version: version || null, locked });
    return ok({});
  });

  // ── claude/usage/history ──────────────────────────────────────────────────
  app.get('/admin/claude/usage/history', { preHandler: app.requireAdmin }, async (req) => {
    const query = req.query as { bucket?: string; period?: string; model?: string };
    const bucket: 'hourly' | 'daily' = query.bucket === 'hourly' ? 'hourly' : 'daily';
    const period: '24h' | '7d' | '30d' =
      query.period === '24h' || query.period === '30d' ? query.period : '7d';
    const data = await claudeUsage.history(bucket, period, query.model ?? null);
    return ok(data);
  });

  // ── openai/state (per-engine kill switch) ─────────────────────────────────
  app.get('/admin/openai/state', { preHandler: app.requireAdmin }, async () => {
    return ok({ disabled: await settings.getFlag('openai_api_disabled', false) });
  });
  app.post('/admin/openai/state', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { disabled?: unknown };
    const disabled = normalizeBool(body.disabled);
    if (disabled === null) throw new ValidationError('disabled must be boolean', { param: 'disabled' });
    await settings.setFlag('openai_api_disabled', disabled);
    await recordLog(ctx, 'admin.openai_api.state', { disabled });
    return ok({ disabled });
  });

  // ── claude/state (per-engine kill switch) ─────────────────────────────────
  app.get('/admin/claude/state', { preHandler: app.requireAdmin }, async () => {
    return ok({ disabled: await settings.getFlag('claude_api_disabled', false) });
  });
  app.post('/admin/claude/state', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { disabled?: unknown };
    const disabled = normalizeBool(body.disabled);
    if (disabled === null) throw new ValidationError('disabled must be boolean', { param: 'disabled' });
    await settings.setFlag('claude_api_disabled', disabled);
    await recordLog(ctx, 'admin.claude_api.state', { disabled });
    return ok({ disabled });
  });

  // ── claude/settings ───────────────────────────────────────────────────────
  app.get('/admin/claude/settings', { preHandler: app.requireAdmin }, async () => {
    const [model, maxTokens, disabled] = await Promise.all([
      settings.getString('claude_default_model', 'claude-sonnet-4-6'),
      settings.getInt('claude_max_tokens', 8192),
      settings.getFlag('claude_api_disabled', false),
    ]);
    return ok({ default_model: model, max_tokens: maxTokens, disabled });
  });
  app.post('/admin/claude/settings', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { default_model?: unknown; max_tokens?: unknown };
    const writes: Record<string, unknown> = {};
    if (typeof body.default_model === 'string' && body.default_model.trim() !== '') {
      const model = body.default_model.trim();
      if (!/^claude[-a-z0-9.]+$/i.test(model)) {
        throw new ValidationError('default_model must be a claude-* model id', {
          param: 'default_model',
        });
      }
      await settings.set('claude_default_model', model);
      writes.default_model = model;
    }
    if (body.max_tokens !== undefined && body.max_tokens !== null) {
      const n = Number(body.max_tokens);
      if (!Number.isFinite(n) || n < 256 || n > 200_000) {
        throw new ValidationError('max_tokens must be 256..200000', { param: 'max_tokens' });
      }
      await settings.setInt('claude_max_tokens', Math.trunc(n));
      writes.max_tokens = Math.trunc(n);
    }
    await recordLog(ctx, 'admin.claude_settings', writes);

    const [model, maxTokens, disabled] = await Promise.all([
      settings.getString('claude_default_model', 'claude-sonnet-4-6'),
      settings.getInt('claude_max_tokens', 8192),
      settings.getFlag('claude_api_disabled', false),
    ]);
    return ok({ default_model: model, max_tokens: maxTokens, disabled });
  });
}
