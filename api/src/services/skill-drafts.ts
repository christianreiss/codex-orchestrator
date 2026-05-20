/**
 * AI-assisted skill drafting. Port of `App\Services\SkillDraftService`. When
 * the runner integration is wired (db + runner client + runner validation),
 * the service POSTs canonical auth + prompt to the runner's
 * `/skills/{generate,assist}` endpoints, normalizes the returned draft, and
 * renders a manifest. Without deps it returns the legacy 501
 * `runner_unavailable` shape so the WebUI can show an actionable prompt.
 */
import { ApiError, ValidationError } from '../http/errors.js';
import type { Database } from '../db/client.js';
import { logs } from '../db/schema.js';
import { nowIso } from '../util/timestamp.js';
import type { RunnerClient } from './runner-client.js';
import type { RunnerValidationService } from './runner-validation.js';
import {
  buildSkillManifest,
  normalizeDraftSlug,
  normalizeSkillDraft,
  type SkillDraft,
} from './skill-manifest.js';
import { ENGINE_CODEX, type Engine } from '../util/engine.js';

export interface SkillDraftsServiceDeps {
  db?: Database;
  runner?: RunnerClient;
  runnerValidation?: RunnerValidationService;
  engine?: Engine;
}

export class SkillDraftsService {
  constructor(private readonly deps: SkillDraftsServiceDeps = {}) {}

  async generate(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
    const slugHintRaw = typeof input?.slug_hint === 'string' ? input.slug_hint.trim() : '';

    if (prompt === '') {
      throw new ValidationError('prompt is required', { param: 'prompt' });
    }

    if (!this.deps.runner || !this.deps.runnerValidation) {
      throw runnerUnavailable();
    }

    const auth = await this.requireCanonicalAuth('skill.generate');
    if (!this.deps.runner.generateSkillDraft) {
      throw new ApiError('Skill generation endpoint is not configured', {
        status: 503,
        code: 'runner_unavailable',
      });
    }
    const result = await this.deps.runner.generateSkillDraft({
      prompt,
      authJson: auth,
      slugHint: slugHintRaw !== '' ? slugHintRaw : null,
    });

    const status = typeof result.status === 'string' ? result.status.toLowerCase().trim() : '';
    if (status !== 'ok') {
      await this.recordLog('skill.generate', {
        status: 'failed',
        reason: result.reason ?? 'generation failed',
        latency_ms: result.latency_ms ?? null,
        reachable: result.reachable ?? null,
      });
      throw new ApiError(
        `Skill generation failed: ${result.reason ?? 'runner returned non-ok status'}`,
        { status: 502, code: 'runner_failed' },
      );
    }

    let draft: SkillDraft;
    try {
      draft = normalizeSkillDraft(result as unknown as Record<string, unknown>);
    } catch {
      await this.recordLog('skill.generate', {
        status: 'failed',
        reason: 'invalid runner draft payload',
        latency_ms: result.latency_ms ?? null,
      });
      throw new ApiError('Skill generation failed: invalid runner draft payload', {
        status: 502,
        code: 'runner_invalid_payload',
      });
    }

    const manifest = buildSkillManifest(draft);
    await this.recordLog('skill.generate', {
      status: 'generated',
      slug: draft.slug,
      latency_ms: result.latency_ms ?? null,
    });

    return {
      ...draft,
      manifest,
      latency_ms: result.latency_ms ?? null,
      codex_version: result.codex_version ?? null,
    };
  }

  async assist(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const messages = normalizeMessages(input?.messages);
    const modeRaw = typeof input?.mode === 'string' ? input.mode.trim().toLowerCase() : 'new';
    if (modeRaw !== 'new' && modeRaw !== 'edit') {
      throw new ValidationError('mode must be new or edit', { param: 'mode' });
    }
    const mode: 'new' | 'edit' = modeRaw;
    const currentSkill = normalizeCurrentSkill(input?.skill, mode);

    if (!this.deps.runner || !this.deps.runnerValidation) {
      throw runnerUnavailable();
    }

    const auth = await this.requireCanonicalAuth('skill.assist', { mode });
    if (!this.deps.runner.assistSkillDraft) {
      throw new ApiError('Skill assist endpoint is not configured', {
        status: 503,
        code: 'runner_unavailable',
      });
    }
    const result = await this.deps.runner.assistSkillDraft({
      messages,
      skill: currentSkill as unknown as Record<string, unknown>,
      authJson: auth,
      mode,
      slugLocked: mode === 'edit',
    });

    const status = typeof result.status === 'string' ? result.status.toLowerCase().trim() : '';
    if (status !== 'ok') {
      await this.recordLog('skill.assist', {
        status: 'failed',
        reason: result.reason ?? 'assist failed',
        mode,
        slug: currentSkill.slug !== '' ? currentSkill.slug : null,
        latency_ms: result.latency_ms ?? null,
        reachable: result.reachable ?? null,
      });
      throw new ApiError(
        `Skill assist failed: ${result.reason ?? 'runner returned non-ok status'}`,
        { status: 502, code: 'runner_failed' },
      );
    }

    const assistantMessage = normalizeAssistantMessage(result.assistant_message);
    if (assistantMessage === null) {
      await this.recordLog('skill.assist', {
        status: 'failed',
        reason: 'invalid runner assist payload',
        mode,
        latency_ms: result.latency_ms ?? null,
      });
      throw new ApiError('Skill assist failed: invalid runner assist payload', {
        status: 502,
        code: 'runner_invalid_payload',
      });
    }

    const draftPayload: Record<string, unknown> = {
      slug: typeof result.slug === 'string' ? result.slug : currentSkill.slug,
      display_name: typeof result.display_name === 'string' ? result.display_name : '',
      description: typeof result.description === 'string' ? result.description : '',
      tags: Array.isArray(result.tags) ? result.tags : [],
      what: typeof result.what === 'string' ? result.what : '',
      when: typeof result.when === 'string' ? result.when : '',
      steps: typeof result.steps === 'string' ? result.steps : '',
    };
    if (mode === 'edit') draftPayload.slug = currentSkill.slug;

    let draft: SkillDraft;
    try {
      draft = normalizeSkillDraft(draftPayload);
    } catch {
      await this.recordLog('skill.assist', {
        status: 'failed',
        reason: 'invalid runner assist payload',
        mode,
        latency_ms: result.latency_ms ?? null,
      });
      throw new ApiError('Skill assist failed: invalid runner assist payload', {
        status: 502,
        code: 'runner_invalid_payload',
      });
    }

    const manifest = buildSkillManifest(draft);
    const changedFields = diffDraftFields(currentSkill, draft);

    await this.recordLog('skill.assist', {
      status: 'generated',
      mode,
      slug: draft.slug,
      changed_fields: changedFields,
      latency_ms: result.latency_ms ?? null,
    });

    return {
      ...draft,
      assistant_message: assistantMessage,
      manifest,
      changed_fields: changedFields,
      latency_ms: result.latency_ms ?? null,
      codex_version: result.codex_version ?? null,
    };
  }

  private async requireCanonicalAuth(
    action: 'skill.generate' | 'skill.assist',
    extras: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const validation = this.deps.runnerValidation!;
    const row = await validation.resolveCanonicalPayload(this.deps.engine ?? ENGINE_CODEX);
    const validated = validation.validateCanonicalPayload(row);
    if (!validated || !validated.auth) {
      await this.recordLog(action, {
        status: 'skipped',
        reason: 'canonical auth missing',
        ...extras,
      });
      throw new ApiError('Canonical auth missing', {
        status: 503,
        code: 'canonical_auth_missing',
      });
    }
    return validated.auth;
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

function runnerUnavailable(): ApiError {
  return new ApiError('Skill draft generation requires the runner integration', {
    status: 503,
    code: 'runner_unavailable',
    extra: {
      next_step:
        'Wire AUTH_RUNNER_URL + AUTH_RUNNER_SHARED_SECRET and the runner-client service to enable AI-assisted skill drafts.',
    },
  });
}

function normalizeMessages(value: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError('messages must be a non-empty array', { param: 'messages' });
  }
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (let i = 0; i < value.length; i++) {
    const message = value[i];
    if (!message || typeof message !== 'object') {
      throw new ValidationError(`messages[${i}] must be an object`, { param: 'messages' });
    }
    const m = message as Record<string, unknown>;
    const role = typeof m.role === 'string' ? m.role.trim().toLowerCase() : '';
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (role !== 'user' && role !== 'assistant') {
      throw new ValidationError(`messages[${i}].role must be user or assistant`, { param: 'messages' });
    }
    if (content === '') {
      throw new ValidationError(`messages[${i}].content is required`, { param: 'messages' });
    }
    out.push({ role, content });
  }
  return out;
}

function normalizeCurrentSkill(value: unknown, mode: 'new' | 'edit'): SkillDraft {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const rawSlug = typeof v.slug === 'string' ? v.slug.trim() : '';
  let slug = '';
  if (rawSlug !== '') {
    slug = normalizeDraftSlug(rawSlug);
  } else if (mode === 'edit') {
    throw new ValidationError('skill.slug is required for edit mode', { param: 'skill' });
  }

  return {
    slug,
    display_name: sanitizeLine(v.display_name),
    description: sanitizeLine(v.description),
    tags: sanitizeTags(v.tags),
    what: sanitizeSection(v.what),
    when: sanitizeSection(v.when),
    steps: sanitizeSection(v.steps),
  };
}

function sanitizeLine(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeSection(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').trim();
}

function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== 'string') continue;
    const normalized = sanitizeLine(tag);
    if (normalized === '' || tags.includes(normalized)) continue;
    tags.push(normalized);
  }
  return tags;
}

function normalizeAssistantMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized === '' ? null : normalized;
}

function diffDraftFields(before: SkillDraft, after: SkillDraft): string[] {
  const changed: string[] = [];
  const keys: Array<keyof SkillDraft> = ['slug', 'display_name', 'description', 'tags', 'what', 'when', 'steps'];
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    const equal = Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && a.every((v, i) => v === b[i])
      : a === b;
    if (!equal) changed.push(key);
  }
  return changed;
}
