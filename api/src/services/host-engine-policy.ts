import type { Host } from '../db/schema.js';
import { ForbiddenError } from '../http/errors.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';

export function hostEnginesList(raw: unknown): Engine[] {
  const text = typeof raw === 'string' ? raw : '';
  const out: Engine[] = [];
  for (const part of text.split(',')) {
    const engine = part.trim().toLowerCase();
    if (engine === ENGINE_CODEX && !out.includes(ENGINE_CODEX)) out.push(ENGINE_CODEX);
    if (engine === ENGINE_CLAUDE && !out.includes(ENGINE_CLAUDE)) out.push(ENGINE_CLAUDE);
  }
  return out.length ? out : [ENGINE_CODEX];
}

export function assertHostEngineEnabled(host: Host, engine: Engine): void {
  const enabled = hostEnginesList(host.engines);
  if (enabled.includes(engine)) return;
  throw new ForbiddenError(`Engine ${engine} is disabled for this host`, 'engine_disabled');
}
