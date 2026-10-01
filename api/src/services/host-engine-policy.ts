import type { Host } from '../db/schema.js';
import { ForbiddenError } from '../http/errors.js';
import { ENGINE_CODEX, isEngine, type Engine } from '../util/engine.js';

export function hostEnginesList(raw: unknown): Engine[] {
  const text = typeof raw === 'string' ? raw : '';
  const out: Engine[] = [];
  for (const part of text.split(',')) {
    const engine = part.trim().toLowerCase();
    if (isEngine(engine) && !out.includes(engine)) out.push(engine);
  }
  return out.length ? out : [ENGINE_CODEX];
}

export function assertHostEngineEnabled(host: Host, engine: Engine): void {
  const enabled = hostEnginesList(host.engines);
  if (enabled.includes(engine)) return;
  throw new ForbiddenError(`Engine ${engine} is disabled for this host`, 'engine_disabled');
}
