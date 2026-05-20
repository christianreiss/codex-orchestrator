/**
 * /admin/overview, /admin/hosts (JSON listing), /admin/logs, /admin/usage,
 * /admin/chatgpt/usage*, /admin/runner/*, /admin/auth/{seed-command,upload},
 * /admin/ws/info, /admin/tokens, /admin/toasts.
 *
 * All endpoints require an admin session (app.requireAdmin). The kill-switch
 * GET /admin/api/state is intentionally NOT gated by the kill-switch in
 * settings — that route lives in ./settings/index.ts.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { RouteContext } from '../../index.js';
import { ok } from '../../../http/reply.js';
import { ValidationError, NotFoundError } from '../../../http/errors.js';
import { adminEvents, hosts, insecureDomainAllows, logs } from '../../../db/schema.js';
import { SettingsService } from '../../../services/settings.js';
import { ClientVersionsService } from '../../../services/client-versions.js';
import { ChatGptUsageService } from '../../../services/chatgpt-usage.js';
import { ClaudeUsageService } from '../../../services/claude-usage.js';
import { DashboardStatsService } from '../../../services/dashboard-stats.js';
import { UsageScalingService } from '../../../services/usage-scaling.js';
import { RunnerProxyService } from '../../../services/runner-proxy.js';
import { createRunnerClient } from '../../../services/runner-client.js';
import { createRunnerValidationService } from '../../../services/runner-validation.js';
import { nowIso, parseIso } from '../../../util/timestamp.js';
import { wsPublisher } from '../../../ws/publisher.js';
import { adminSpaHtmlPreHandler } from '../pages/static.js';

function intQuery(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function stringQuery(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isoOffsetDays(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function startOfDayIso(now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function startOfMonthIso(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function startOfNextMonthIso(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
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
    /* best-effort */
  }
}

interface WsInfoEnv {
  ADMIN_WS_ENABLED: boolean;
  ADMIN_WS_PUBLIC_URL?: string;
  ADMIN_WS_HEARTBEAT_SECONDS?: number;
  ADMIN_WS_BACKLOG_LIMIT?: number;
  PUBLIC_BASE_URL?: string;
}

export function buildWsInfo(env: WsInfoEnv): {
  enabled: boolean;
  url: string | null;
  heartbeat_seconds: number;
  backlog_limit: number;
} {
  const enabled = Boolean(env.ADMIN_WS_ENABLED);
  let url: string | null = null;
  if (enabled) {
    const publicUrl = (env.ADMIN_WS_PUBLIC_URL ?? '').trim();
    if (publicUrl && /^wss?:\/\//.test(publicUrl)) {
      url = publicUrl;
    } else if (env.PUBLIC_BASE_URL) {
      const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
      let wsUrl = `${base}/admin/ws`;
      if (wsUrl.startsWith('https://')) wsUrl = 'wss://' + wsUrl.slice('https://'.length);
      else if (wsUrl.startsWith('http://')) wsUrl = 'ws://' + wsUrl.slice('http://'.length);
      url = wsUrl;
    } else {
      url = '/admin/ws';
    }
  }
  const heartbeatRaw = env.ADMIN_WS_HEARTBEAT_SECONDS ?? 25;
  const heartbeat = Math.max(5, Math.trunc(heartbeatRaw));
  const backlogRaw = env.ADMIN_WS_BACKLOG_LIMIT ?? 200;
  const backlog = Math.max(1, Math.min(500, Math.trunc(backlogRaw)));
  return { enabled, url, heartbeat_seconds: heartbeat, backlog_limit: backlog };
}

export async function registerAdminOverviewRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const adminSpa = adminSpaHtmlPreHandler(ctx);
  const settings = new SettingsService(ctx.db);
  const clientVersions = new ClientVersionsService(settings, app.log);
  const chatgpt = new ChatGptUsageService(ctx.db, app.log, {
    env: ctx.env,
    keyring: ctx.keyring,
    runnerValidation: createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring }),
  });
  const claude = new ClaudeUsageService(ctx.db);
  const dashboard = new DashboardStatsService(ctx.db);
  const scaling = new UsageScalingService(settings);
  const runnerProxy = new RunnerProxyService(ctx.env, app.log, {
    db: ctx.db,
    runner: createRunnerClient({ env: ctx.env }),
    runnerValidation: createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring }),
  });

  // ── /admin/overview ───────────────────────────────────────────────────────
  app.get('/admin/overview', { preHandler: app.requireAdmin }, async () => {
    const hostRows = await ctx.db.select().from(hosts);
    const latestLog = await dashboard.latestLog();

    const [versionSummary, claudeVersionSummary] = await Promise.all([
      clientVersions.versionSummary('codex'),
      clientVersions.versionSummary('claude'),
    ]);

    let lastRefresh: string | null = null;
    let totalSeconds = 0;
    let countSeconds = 0;
    const now = Date.now();
    for (const h of hostRows) {
      const lr = h.lastRefresh;
      if (lr) {
        if (!lastRefresh || lr > lastRefresh) lastRefresh = lr;
        const t = parseIso(lr)?.getTime();
        if (t) {
          totalSeconds += (now - t) / 1000;
          countSeconds += 1;
        }
      }
    }
    const avgRefreshAgeDays = countSeconds > 0 ? totalSeconds / countSeconds / 86400 : null;

    const dayStart = startOfDayIso();
    const dayEnd = isoOffsetDays(1);
    const monthStart = startOfMonthIso();
    const monthEnd = startOfNextMonthIso();
    const weekStart = isoOffsetDays(-6);
    const weekEnd = nowIso();

    const [tokens, tokensDay, tokensMonth, tokensWeek, topHost] = await Promise.all([
      dashboard.totals(),
      dashboard.totalsForRange(dayStart, dayEnd),
      dashboard.totalsForRange(monthStart, monthEnd),
      dashboard.totalsForRange(weekStart, weekEnd),
      dashboard.topHost(),
    ]);

    const chatgptResult = await chatgpt.fetchLatest(false);
    const chatgptSummary = await chatgpt.latestWindowSummary();
    const claudeSummary = await claude.dashboardSummary();

    const [
      quotaHardFail,
      quotaLimitPercent,
      quotaWeekPartition,
      cdxSilent,
      adminTheme,
      reverseDnsEnabled,
      insecureApprovalEnabled,
      autoUpdateEnabled,
      inactivityWindowDays,
      logRetentionEnabled,
      logRetentionDaysLogs,
      logRetentionDaysMcp,
      logRetentionDaysEvents,
      logRetentionDaysGraphStats,
      clientVersionLock,
      claudeApiDisabled,
      claudeDefaultModel,
      scalingStatus,
    ] = await Promise.all([
      settings.getFlag('quota_hard_fail', true),
      settings.getInt('quota_limit_percent', 95),
      settings.getString('quota_week_partition', 'off'),
      settings.getFlag('cdx_silent', false),
      settings.getString('admin_theme', 'auto'),
      settings.getFlag('reverse_dns_enabled', false),
      settings.getFlag('insecure_approval_enabled', false),
      settings.getFlag('auto_update_enabled', false),
      settings.getInt('inactivity_window_days', 7),
      settings.getFlag('log_retention_enabled', false),
      settings.getInt('log_retention_days_logs', 90),
      settings.getInt('log_retention_days_mcp', 90),
      settings.getInt('log_retention_days_events', 30),
      settings.getInt('log_retention_days_graph_stats', 180),
      settings.getWithMeta('client_version_lock'),
      settings.getFlag('claude_api_disabled', false),
      settings.getString('claude_default_model', 'claude-sonnet-4-6'),
      scaling.currentStatus(),
    ]);

    return ok({
      totals: { hosts: hostRows.length },
      latest_log_at: latestLog?.createdAt ?? null,
      last_refresh: lastRefresh,
      avg_refresh_age_days: avgRefreshAgeDays,
      versions: {
        ...versionSummary,
        claude_version: claudeVersionSummary.client_version,
        claude_wrapper_version: claudeVersionSummary.wrapper_version,
      },
      tokens: { ...tokens, top_host: topHost },
      tokens_day: tokensDay,
      tokens_month: tokensMonth,
      tokens_week: tokensWeek,
      chatgpt_usage: chatgptResult.snapshot,
      chatgpt_usage_summary: chatgptSummary,
      chatgpt_cached: chatgptResult.cached,
      chatgpt_next_eligible_at: chatgptResult.next_eligible_at,
      claude_usage_summary: claudeSummary,
      quota_hard_fail: quotaHardFail,
      quota_limit_percent: quotaLimitPercent,
      quota_week_partition: quotaWeekPartition,
      cdx_silent: cdxSilent,
      admin_theme: adminTheme,
      reverse_dns_enabled: reverseDnsEnabled,
      insecure_approval_enabled: insecureApprovalEnabled,
      auto_update_enabled: autoUpdateEnabled,
      inactivity_window_days: inactivityWindowDays,
      log_retention_enabled: logRetentionEnabled,
      log_retention_days_logs: logRetentionDaysLogs,
      log_retention_days_mcp: logRetentionDaysMcp,
      log_retention_days_events: logRetentionDaysEvents,
      log_retention_days_graph_stats: logRetentionDaysGraphStats,
      client_version_lock: clientVersionLock.value,
      client_version_lock_updated_at: clientVersionLock.updatedAt,
      scaling: scalingStatus,
      claude_api_disabled: claudeApiDisabled,
      claude_default_model: claudeDefaultModel,
    });
  });

  // ── /admin/ws/info ────────────────────────────────────────────────────────
  app.get('/admin/ws/info', { preHandler: app.requireAdmin }, async () => {
    const info = buildWsInfo({
      ADMIN_WS_ENABLED: ctx.env.ADMIN_WS_ENABLED,
      ADMIN_WS_PUBLIC_URL: ctx.env.ADMIN_WS_PUBLIC_URL,
      ADMIN_WS_HEARTBEAT_SECONDS: ctx.env.ADMIN_WS_HEARTBEAT_SECONDS,
      ADMIN_WS_BACKLOG_LIMIT: ctx.env.ADMIN_WS_BACKLOG_LIMIT,
      PUBLIC_BASE_URL: ctx.env.PUBLIC_BASE_URL,
    });
    return ok({ ...info, last_event_id: 0 });
  });

  // ── /admin/hosts (JSON listing) ───────────────────────────────────────────
  app.get('/admin/hosts', { preHandler: [adminSpa, app.requireAdmin] }, async () => {
    const rows = await ctx.db.select().from(hosts).orderBy(hosts.fqdn);
    return ok({
      hosts: rows.map((h) => ({
        id: Number(h.id),
        fqdn: h.fqdn,
        status: h.status,
        last_refresh: h.lastRefresh,
        claude_last_refresh: h.claudeLastRefresh,
        updated_at: h.updatedAt,
        created_at: h.createdAt,
        client_version: h.clientVersion,
        claude_client_version: h.claudeClientVersion,
        client_version_override: h.clientVersionOverride,
        claude_client_version_override: h.claudeClientVersionOverride,
        wrapper_version: h.wrapperVersion,
        claude_wrapper_version: h.claudeWrapperVersion,
        api_calls: Number(h.apiCalls ?? 0),
        ip4: h.ip4,
        ip6: h.ip6,
        secure: h.secure === 1,
        vip: h.vip === 1,
        allow_roaming_ips: h.allowRoamingIps === 1,
        scaling_exempt: h.scalingExempt === 1,
        curl_insecure: h.curlInsecure === 1,
        browseros_mcp_enabled: h.browserosMcpEnabled === 1,
        insecure_enabled_until: h.insecureEnabledUntil,
        insecure_grace_until: h.insecureGraceUntil,
        insecure_window_minutes: h.insecureWindowMinutes,
        last_cron_check: h.lastCronCheck,
        reverse_dns_mode: h.reverseDnsMode,
        lane_preference: h.lanePreference,
        model_override: h.modelOverride,
        reasoning_effort_override: h.reasoningEffortOverride,
        claude_model_override: h.claudeModelOverride,
        claude_reasoning_effort_override: h.claudeReasoningEffortOverride,
        engines: h.engines,
        auto_update_override: h.autoUpdateOverride === null ? null : h.autoUpdateOverride === 1,
        canonical_digest: h.authDigest,
        claude_canonical_digest: h.claudeAuthDigest,
        config_version: Number(h.configVersion ?? 0),
        wrapper_track: h.wrapperTrack,
      })),
    });
  });

  // ── /admin/hosts/:id/detail ───────────────────────────────────────────────
  app.get('/admin/hosts/:id/detail', { preHandler: app.requireAdmin }, async (req) => {
    const params = req.params as { id: string };
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ValidationError('id must be a positive integer', { param: 'id' });
    }
    const rows = await ctx.db.select().from(hosts).where(eq(hosts.id, id)).limit(1);
    const h = rows[0];
    if (!h) throw new NotFoundError('Host not found', 'host_not_found');
    const [codexVersions, claudeVersions, autoUpdateEnabled, reverseDnsEnabled, inactivityWindowDays] =
      await Promise.all([
        clientVersions.versionSummary('codex'),
        clientVersions.versionSummary('claude'),
        settings.getFlag('auto_update_enabled', false),
        settings.getFlag('reverse_dns_enabled', false),
        settings.getInt('inactivity_window_days', 7),
      ]);
    return ok({
      host: {
        id: Number(h.id),
        fqdn: h.fqdn,
        status: h.status,
        last_refresh: h.lastRefresh,
        claude_last_refresh: h.claudeLastRefresh,
        updated_at: h.updatedAt,
        created_at: h.createdAt,
        client_version: h.clientVersion,
        claude_client_version: h.claudeClientVersion,
        wrapper_version: h.wrapperVersion,
        claude_wrapper_version: h.claudeWrapperVersion,
        api_calls: Number(h.apiCalls ?? 0),
        ip4: h.ip4,
        ip6: h.ip6,
        secure: h.secure === 1,
        vip: h.vip === 1,
        engines: h.engines,
        canonical_digest: h.authDigest,
        claude_canonical_digest: h.claudeAuthDigest,
        lane_preference: h.lanePreference,
        browseros_mcp_enabled: h.browserosMcpEnabled === 1,
        model_override: h.modelOverride,
        claude_model_override: h.claudeModelOverride,
        config_version: Number(h.configVersion ?? 0),
      },
      overview: {
        versions: {
          client_version: codexVersions.client_version,
          wrapper_version: codexVersions.wrapper_version,
          client_version_checked_at: codexVersions.client_version_checked_at,
          claude_version: claudeVersions.client_version,
        },
        reverse_dns_enabled: reverseDnsEnabled,
        auto_update_enabled: autoUpdateEnabled,
        inactivity_window_days: inactivityWindowDays,
      },
    });
  });

  // ── /admin/hosts/insecure ─────────────────────────────────────────────────
  app.get('/admin/hosts/insecure', { preHandler: app.requireAdmin }, async () => {
    const allHosts = await ctx.db.select().from(hosts);
    const nowMs = Date.now();
    const items: Array<{
      id: number;
      fqdn: string;
      active: boolean;
      insecure_enabled_until: string | null;
      secure: boolean;
    }> = [];
    let active = 0;
    for (const h of allHosts) {
      const isSecure = h.secure === 1;
      if (isSecure) continue;
      const enabledUntil = h.insecureEnabledUntil ? new Date(h.insecureEnabledUntil).toISOString() : null;
      const ts = enabledUntil ? parseIso(enabledUntil)?.getTime() : null;
      const isActive = ts !== null && ts !== undefined && ts > nowMs;
      if (!isActive) continue;
      active += 1;
      items.push({
        id: Number(h.id),
        fqdn: h.fqdn,
        active: true,
        insecure_enabled_until: enabledUntil,
        secure: false,
      });
    }
    items.sort((a, b) => a.fqdn.localeCompare(b.fqdn));

    const domainRows = await ctx.db.select().from(insecureDomainAllows);
    const domains: Array<{
      id: number;
      domain: string;
      active: boolean;
      enabled_until: string | null;
      window_minutes: number | null;
    }> = [];
    let domainsActive = 0;
    for (const row of domainRows) {
      if (row.revokedAt) continue;
      const enabledUntil = row.enabledUntil ?? null;
      const ts = enabledUntil ? parseIso(enabledUntil)?.getTime() : null;
      const isActive = ts !== null && ts !== undefined && ts > nowMs;
      if (!isActive) continue;
      domainsActive += 1;
      domains.push({
        id: Number(row.id),
        domain: row.domain,
        active: true,
        enabled_until: enabledUntil,
        window_minutes: row.windowMinutes ?? null,
      });
    }
    domains.sort((a, b) => a.domain.localeCompare(b.domain));

    return ok({
      count: items.length,
      active,
      hosts: items,
      domains,
      domains_active: domainsActive,
    });
  });

  app.post('/admin/hosts/insecure/extend', { preHandler: app.requireAdmin }, async () => {
    const allHosts = await ctx.db.select().from(hosts);
    const nowMs = Date.now();
    let extended = 0;
    for (const h of allHosts) {
      if (h.secure === 1) continue;
      const enabledUntilMs = h.insecureEnabledUntil ? new Date(h.insecureEnabledUntil).getTime() : 0;
      if (enabledUntilMs <= nowMs) continue;
      const minutesRaw = h.insecureWindowMinutes ?? 60;
      const minutes = Math.max(5, Math.min(1440, minutesRaw));
      const newUntil = new Date(nowMs + minutes * 60_000);
      await ctx.db
        .update(hosts)
        .set({ insecureEnabledUntil: newUntil, updatedAt: nowIso() })
        .where(eq(hosts.id, h.id));
      await recordLog(ctx, 'admin.host.insecure_extend', {
        fqdn: h.fqdn,
        enabled_until: newUntil.toISOString(),
        window_minutes: minutes,
      });
      wsPublisher.publish('host.updated', { id: Number(h.id) });
      extended += 1;
    }
    return ok({ extended });
  });

  app.post('/admin/hosts/insecure/disable-all', { preHandler: app.requireAdmin }, async () => {
    const allHosts = await ctx.db.select().from(hosts);
    const nowMs = Date.now();
    let disabled = 0;
    for (const h of allHosts) {
      if (h.secure === 1) continue;
      const enabledUntilMs = h.insecureEnabledUntil ? new Date(h.insecureEnabledUntil).getTime() : 0;
      if (enabledUntilMs <= nowMs) continue;
      await ctx.db
        .update(hosts)
        .set({ insecureEnabledUntil: null, insecureGraceUntil: null, updatedAt: nowIso() })
        .where(eq(hosts.id, h.id));
      await recordLog(ctx, 'admin.host.insecure_disable', { fqdn: h.fqdn });
      wsPublisher.publish('host.updated', { id: Number(h.id) });
      disabled += 1;
    }
    return ok({ disabled });
  });

  // ── /admin/logs ───────────────────────────────────────────────────────────
  app.get('/admin/logs', { preHandler: app.requireAdmin }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const limit = Math.max(1, Math.min(500, intQuery(q.limit, 50)));
    const rows = await dashboard.recentLogs(limit);
    return ok({ logs: rows });
  });

  // ── /admin/usage/ingests ──────────────────────────────────────────────────
  app.get('/admin/usage/ingests', { preHandler: app.requireAdmin }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const hostIdRaw = q.host_id !== undefined ? Number(q.host_id) : null;
    const hostId = hostIdRaw !== null && Number.isFinite(hostIdRaw) ? hostIdRaw : null;
    const result = await dashboard.ingestsSearch({
      page: intQuery(q.page, 1),
      perPage: intQuery(q.per_page, 50),
      hostId,
      query: stringQuery(q.q),
      sort: stringQuery(q.sort) ?? 'created_at',
      direction: stringQuery(q.direction) === 'asc' ? 'asc' : 'desc',
    });
    return ok(result);
  });

  // ── /admin/usage ──────────────────────────────────────────────────────────
  app.get('/admin/usage', { preHandler: app.requireAdmin }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const limit = Math.max(1, Math.min(500, intQuery(q.limit, 50)));
    const usages = await dashboard.recentTokens(limit);
    const dayStart = startOfDayIso();
    const dayEnd = isoOffsetDays(1);
    const weekStart = isoOffsetDays(-6);
    const weekEnd = nowIso();
    const monthStart = isoOffsetDays(-29);
    const monthEnd = nowIso();
    const [tokensDay, tokensWeek, tokensMonth] = await Promise.all([
      dashboard.totalsForRange(dayStart, dayEnd),
      dashboard.totalsForRange(weekStart, weekEnd),
      dashboard.totalsForRange(monthStart, monthEnd),
    ]);
    return ok({
      usages,
      totals: {
        day: tokensDay,
        '7d': tokensWeek,
        '30d': tokensMonth,
      },
    });
  });

  // ── /admin/chatgpt/usage* ─────────────────────────────────────────────────
  app.get('/admin/chatgpt/usage', { preHandler: app.requireAdmin }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const force = q.force !== undefined && q.force !== '0' && q.force !== 'false';
    const result = await chatgpt.fetchLatest(force);
    return ok(result);
  });

  app.get('/admin/chatgpt/usage/history', { preHandler: app.requireAdmin }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const days = intQuery(q.days, 60);
    const interval = (stringQuery(q.interval) ?? 'day').toLowerCase();
    const lane = (stringQuery(q.lane) ?? 'both').toLowerCase();
    const window = (stringQuery(q.window) ?? 'both').toLowerCase();
    if (!['raw', 'hour', 'day'].includes(interval)) {
      throw new ValidationError('interval must be one of: raw, hour, day', { param: 'interval' });
    }
    if (!['normal', 'spark', 'both'].includes(lane)) {
      throw new ValidationError('lane must be one of: normal, spark, both', { param: 'lane' });
    }
    if (!['primary', 'secondary', 'both'].includes(window)) {
      throw new ValidationError('window must be one of: primary, secondary, both', { param: 'window' });
    }
    const from = stringQuery(q.from);
    const until = stringQuery(q.until);
    if (from !== null && Number.isNaN(Date.parse(from))) {
      throw new ValidationError('Invalid from timestamp', { param: 'from' });
    }
    if (until !== null && Number.isNaN(Date.parse(until))) {
      throw new ValidationError('Invalid until timestamp', { param: 'until' });
    }
    if (from && until && Date.parse(from) > Date.parse(until)) {
      throw new ValidationError('from must be before until', { param: 'from' });
    }
    const history = await chatgpt.history({
      days,
      from,
      until,
      interval: interval as 'raw' | 'hour' | 'day',
      lane: lane as 'normal' | 'spark' | 'both',
      window: window as 'primary' | 'secondary' | 'both',
    });
    return ok(history);
  });

  app.post('/admin/chatgpt/usage/refresh', { preHandler: app.requireAdmin }, async () => {
    const result = await chatgpt.refresh();
    return ok(result);
  });

  // ── /admin/tokens ─────────────────────────────────────────────────────────
  app.get('/admin/tokens', { preHandler: app.requireAdmin }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const limit = Math.max(1, Math.min(500, intQuery(q.limit, 50)));
    const tokens = await dashboard.topTokens(limit);
    return ok({ tokens });
  });

  // ── /admin/toasts ─────────────────────────────────────────────────────────
  app.post('/admin/toasts', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as {
      message?: unknown;
      title?: unknown;
      level?: unknown;
      timeout_ms?: unknown;
    };
    let message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) throw new ValidationError('message is required', { param: 'message' });
    if (message.length > 500) message = message.slice(0, 500);

    let title: string | null = null;
    if (typeof body.title === 'string' && body.title.trim() !== '') {
      title = body.title.trim().slice(0, 120);
    }

    const levelRaw = typeof body.level === 'string' ? body.level.trim().toLowerCase() : 'info';
    const level =
      levelRaw === 'ok' || levelRaw === 'success'
        ? 'success'
        : levelRaw === 'warning' || levelRaw === 'warn'
          ? 'warn'
          : levelRaw === 'error' || levelRaw === 'fail' || levelRaw === 'danger'
            ? 'error'
            : 'info';

    let timeoutMs: number | null = null;
    if (body.timeout_ms !== undefined && body.timeout_ms !== null) {
      const n = Number(body.timeout_ms);
      if (Number.isFinite(n)) {
        timeoutMs = Math.max(1000, Math.min(20_000, Math.trunc(n)));
      }
    }

    const payload = { message, title, level, timeout_ms: timeoutMs };
    const now = nowIso();
    let eventId: number | null = null;
    try {
      const result = await ctx.db.insert(adminEvents).values({
        type: 'toast',
        hostId: null,
        payload: payload as unknown as Record<string, unknown>,
        createdAt: now,
      });
      const insertId = Array.isArray(result)
        ? (result[0] as { insertId?: number }).insertId
        : (result as unknown as { insertId?: number }).insertId;
      if (typeof insertId === 'number') eventId = insertId;
    } catch (err) {
      app.log.warn({ err }, 'failed to record admin toast event');
    }

    await recordLog(ctx, 'admin.toast', { level, title });
    wsPublisher.publish('toast', payload);

    return ok({ event: { id: eventId, type: 'toast', payload, created_at: now } });
  });

  // ── /admin/runner/* ───────────────────────────────────────────────────────
  app.get('/admin/runner', { preHandler: app.requireAdmin }, async () => {
    return ok({ runner: await runnerProxy.status() });
  });
  app.post('/admin/runner/run', { preHandler: app.requireAdmin }, async (req) => {
    const result = await runnerProxy.run((req.body ?? {}) as Record<string, unknown>, 'codex');
    return ok(result);
  });
  app.post('/admin/runner/run-claude', { preHandler: app.requireAdmin }, async (req) => {
    const result = await runnerProxy.run((req.body ?? {}) as Record<string, unknown>, 'claude');
    return ok(result);
  });

  // ── /admin/auth/seed-command ──────────────────────────────────────────────
  app.post('/admin/auth/seed-command', { preHandler: app.requireAdmin }, async (req) => {
    const result = await runnerProxy.seedCommand((req.body ?? {}) as Record<string, unknown>);
    return ok(result);
  });

  // ── /admin/auth/upload (multipart) ────────────────────────────────────────
  app.post('/admin/auth/upload', { preHandler: app.requireAdmin }, async (req) => {
    // @fastify/multipart adds `parts()` at runtime when registered by the
    // foundation server. We read the first file part defensively; until the
    // host-sync/runner-validation pipeline is wired we log a TODO and return
    // queued=true.
    let received = false;
    let filename: string | null = null;
    let size = 0;
    try {
      const r = req as unknown as {
        parts?: () => AsyncIterable<{
          type: 'file' | 'field';
          filename?: string;
          file?: AsyncIterable<Buffer>;
        }>;
      };
      if (typeof r.parts === 'function') {
        for await (const part of r.parts()) {
          if (part.type === 'file' && part.file) {
            received = true;
            filename = part.filename ?? null;
            for await (const chunk of part.file) {
              size += (chunk as Buffer).byteLength;
              if (size > 64 * 1024 * 1024) break; // 64 MB cap
            }
          }
        }
      }
    } catch (err) {
      app.log.warn({ err }, 'admin.auth.upload multipart parse failed');
    }
    await recordLog(ctx, 'admin.auth.upload', {
      received,
      filename,
      size,
      todo: 'host-sync runner-validation not yet wired (Phase 2.1)',
    });
    return ok({ status: 'ok', queued: true, received, filename, size });
  });
}
