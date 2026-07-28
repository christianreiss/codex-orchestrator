/**
 * AI-assisted project drafting. Port of `App\Services\ProjectDraftService`.
 * Calls the runner's `/projects/assist` endpoint with the project's current
 * detail snapshot and returns sanitized about / roster suggestions plus a
 * changed-fields diff. Without runner+db deps it returns the legacy 503
 * `runner_unavailable` shape.
 */
import { ApiError } from '../http/errors.js';
import type { Database } from '../db/client.js';
import { logs } from '../db/schema.js';
import { nowIso } from '../util/timestamp.js';
import { ENGINE_CODEX, type Engine } from '../util/engine.js';
import type { ProjectDetail, ProjectsService } from './projects.js';
import type { RunnerClient } from './runner-client.js';
import type { RunnerValidationService } from './runner-validation.js';

export interface ProjectDraftsServiceDeps {
  db?: Database;
  projects?: ProjectsService;
  runner?: RunnerClient;
  runnerValidation?: RunnerValidationService;
  engine?: Engine;
}

interface CurrentDraft {
  title: string;
  name: string;
  description: string;
  roster_markdown: string;
}

export class ProjectDraftsService {
  constructor(private readonly deps: ProjectDraftsServiceDeps = {}) {}

  async assist(slug: string): Promise<Record<string, unknown>> {
    if (!this.deps.runner || !this.deps.runnerValidation || !this.deps.projects) {
      throw new ApiError('Project assist requires the runner integration', {
        status: 503,
        code: 'runner_unavailable',
        extra: {
          next_step:
            'Wire AUTH_RUNNER_URL + AUTH_RUNNER_SHARED_SECRET and the runner-client service to enable AI-assisted project drafts.',
        },
      });
    }

    const validation = this.deps.runnerValidation;
    const engine = this.deps.engine ?? ENGINE_CODEX;
    const row = await validation.resolveCanonicalPayload(engine);
    const auth = row ? validation.canonicalAuthFromPayload(row) : null;
    if (!auth) {
      await this.recordLog('project.assist', {
        status: 'skipped',
        reason: 'canonical auth missing',
        slug,
      });
      throw new ApiError('Canonical auth missing', {
        status: 503,
        code: 'canonical_auth_missing',
      });
    }

    const detail = await this.deps.projects.detail(slug);
    const currentDraft = currentDraftFromDetail(detail);
    const runnerProject = buildRunnerProjectContext(detail);

    if (!this.deps.runner.assistProjectDraft) {
      throw new ApiError('Project assist endpoint is not configured', {
        status: 503,
        code: 'runner_unavailable',
      });
    }
    const result = await this.deps.runner.assistProjectDraft({
      slug,
      project: runnerProject,
      authJson: auth,
      engine,
    });

    const status = typeof result.status === 'string' ? result.status.toLowerCase().trim() : '';
    if (status !== 'ok') {
      await this.recordLog('project.assist', {
        status: 'failed',
        reason: result.reason ?? 'assist failed',
        slug,
        latency_ms: result.latency_ms ?? null,
        reachable: result.reachable ?? null,
      });
      throw new ApiError(`Project assist failed: ${result.reason ?? 'runner returned non-ok status'}`, {
        status: 502,
        code: 'runner_failed',
      });
    }

    const assistantMessage = sanitizeLine(result.assistant_message, 240);
    if (assistantMessage === null || assistantMessage === '') {
      await this.recordLog('project.assist', {
        status: 'failed',
        reason: 'invalid runner assist payload',
        slug,
        latency_ms: result.latency_ms ?? null,
      });
      throw new ApiError('Project assist failed: invalid runner assist payload', {
        status: 502,
        code: 'runner_invalid_payload',
      });
    }

    const draft = buildDraftPayload(result, currentDraft);
    const responseSlug = detail.project.slug ?? slug;

    await this.recordLog('project.assist', {
      status: 'generated',
      slug: responseSlug,
      changed_fields: draft.changed_fields,
      latency_ms: result.latency_ms ?? null,
    });

    return {
      project: responseSlug,
      about: draft.about,
      roster_markdown: draft.roster_markdown,
      assistant_message: assistantMessage,
      changed_fields: draft.changed_fields,
      latency_ms: result.latency_ms ?? null,
      codex_version: result.codex_version ?? null,
    };
  }

  private async recordLog(action: string, details: Record<string, unknown>): Promise<void> {
    if (!this.deps.db) return;
    try {
      await this.deps.db.insert(logs).values({
        hostId: null,
        action,
        details: JSON.stringify(details),
        createdAt: nowIso(),
        engine: this.deps.engine ?? null,
      });
    } catch {
      /* non-fatal */
    }
  }
}

function currentDraftFromDetail(detail: ProjectDetail): CurrentDraft {
  const about = (detail.project.about ?? {}) as Record<string, unknown>;
  return {
    title: typeof about.title === 'string' ? about.title.trim() : '',
    name: typeof about.name === 'string' ? about.name.trim() : '',
    description: typeof about.description === 'string' ? about.description.trim() : '',
    roster_markdown: (detail.project.roster_markdown ?? '').trim(),
  };
}

function buildRunnerProjectContext(detail: ProjectDetail): Record<string, unknown> {
  const about = (detail.project.about ?? {}) as Record<string, unknown>;
  return {
    slug: detail.project.slug,
    about: {
      title: typeof about.title === 'string' ? about.title.trim() : '',
      name: typeof about.name === 'string' ? about.name.trim() : '',
      description: typeof about.description === 'string' ? about.description.trim() : '',
    },
    roster_markdown: (detail.project.roster_markdown ?? '').trim(),
    counts: detail.project.counts,
    notes: sliceItems(detail.notes, ['id', 'header', 'body', 'updatedAt'], 6, 800),
    todos: sliceItems(detail.todos, ['id', 'title', 'detail', 'done', 'updatedAt'], 8, 600),
    files: sliceItems(
      detail.files,
      ['id', 'stored_name', 'description', 'mime_type', 'size_bytes', 'content'],
      6,
      900,
    ),
    feedback: sliceItems(detail.feedback, ['id', 'type', 'title', 'body', 'status', 'updatedAt'], 8, 700),
    recent_changes: sliceItems(
      detail.recent_changes,
      ['seq', 'eventType', 'action', 'payloadJson', 'createdAt'],
      10,
      500,
    ),
  };
}

function sliceItems(
  items: unknown,
  keys: string[],
  limit: number,
  textLimit: number,
): Array<Record<string, unknown>> {
  if (!Array.isArray(items)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of items.slice(0, limit)) {
    if (!item || typeof item !== 'object') continue;
    const src = item as Record<string, unknown>;
    const row: Record<string, unknown> = {};
    for (const key of keys) {
      if (!(key in src)) continue;
      const value = src[key];
      if (typeof value === 'string') {
        row[key] = truncateText(value, textLimit);
        continue;
      }
      if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
        const encoded = JSON.stringify(value);
        row[key] = typeof encoded === 'string' ? truncateText(encoded, textLimit) : '';
        continue;
      }
      if (value === null || ['number', 'boolean'].includes(typeof value)) {
        row[key] = value;
      }
    }
    out.push(row);
  }
  return out;
}

function buildDraftPayload(
  result: Record<string, unknown>,
  current: CurrentDraft,
): { about: Record<string, string>; roster_markdown: string; changed_fields: string[] } {
  const about: Record<string, string> = {};
  const changedFields: string[] = [];

  const fieldLimits: Array<['title' | 'name' | 'description', number]> = [
    ['title', 120],
    ['name', 120],
    ['description', 220],
  ];
  for (const [field, maxLen] of fieldLimits) {
    const sanitized = sanitizeLine(result[field], maxLen);
    if (sanitized === null || sanitized === '' || sanitized === current[field]) continue;
    about[field] = sanitized;
    changedFields.push(field);
  }

  let roster = sanitizeBlock(result.roster_markdown, 4000);
  if (roster === null || roster === '' || roster === current.roster_markdown) {
    roster = '';
  } else {
    changedFields.push('roster_markdown');
  }

  return { about, roster_markdown: roster, changed_fields: changedFields };
}

function sanitizeLine(value: unknown, maxLen: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return null;
  if (!['string', 'number'].includes(typeof value)) return null;
  let sanitized = String(value).replace(/\s+/g, ' ').trim();
  sanitized = sanitized.replace(/^[\s\t\n\r`"'-]+|[\s\t\n\r`"'-]+$/g, '');
  if (sanitized === '') return '';
  if (sanitized.length > maxLen) {
    sanitized = sanitized.slice(0, maxLen - 3).replace(/[\s,;:.]+$/, '') + '...';
  }
  return sanitized;
}

function sanitizeBlock(value: unknown, maxLen: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return null;
  if (!['string', 'number'].includes(typeof value)) return null;
  let normalized = String(value).replace(/\r\n/g, '\n').trim();
  if (normalized === '') return '';
  if (normalized.length > maxLen) {
    normalized = normalized.slice(0, maxLen - 3).replace(/[\s\n\r\t]+$/, '') + '...';
  }
  return normalized;
}

function truncateText(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit - 3).replace(/[\s\n\r\t]+$/, '') + '...';
}
