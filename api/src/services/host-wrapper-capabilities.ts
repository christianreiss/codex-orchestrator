import type { Host } from '../db/schema.js';
import type { Engine } from '../util/engine.js';

/** Render for this caller, including its first sync before /cron/report.
 * This is capability negotiation, never authentication or a persisted version
 * report. Other engines and every host policy field retain their stored value.
 * Missing headers preserve compatibility; invalid releases still fail the
 * renderer's existing version gates instead of borrowing a newer stored value.
 */
export function hostWithCallerWrapper(host: Host, engine: Engine, version: string | string[] | undefined): Host {
  if (version === undefined) return host;
  const value = typeof version === 'string' && version.length <= 128 ? version.trim() : '';
  const field = engine === 'claude' ? 'claudeWrapperVersion' : engine === 'grok' ? 'grokWrapperVersion' : 'wrapperVersion';
  return { ...host, [field]: value };
}
