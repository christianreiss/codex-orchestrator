import { z } from 'zod';

export const daemonSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    username: z
      .string()
      .regex(/^[a-z_][a-z0-9_-]*[$]?$/i)
      .max(64)
      .default('root'),
    default_cwd: z
      .string()
      .max(1024)
      .refine((v) => v === '' || (v.startsWith('/') && !v.includes('\0')), 'Use an absolute directory')
      .default(''),
    max_parallel: z.number().int().min(1).max(64).default(8),
    idle_minutes: z.number().int().min(1).max(1440).default(60),
    question_minutes: z.number().int().min(1).max(10080).default(1440),
  })
  .strict();
export type DaemonSettings = z.infer<typeof daemonSettingsSchema>;
export interface DaemonRuntime {
  instance_id: string;
  generation: string;
  username: string;
  version: string;
  heartbeat_at: string;
  connected: boolean;
  engines: string[];
  error: string | null;
}
export interface DaemonHealth {
  state: 'disabled' | 'green' | 'yellow' | 'red';
  reasons: string[];
  heartbeat_at: string | null;
  used_slots: number;
  max_slots: number;
  evaluated_at: string;
}
export function daemonHealth(
  settings: DaemonSettings,
  runtime: DaemonRuntime | null,
  enabledAt: string | null,
  used: number,
  engines: string[],
  now = Date.now(),
): DaemonHealth {
  const result: DaemonHealth = {
    state: 'green',
    reasons: [],
    heartbeat_at: runtime?.heartbeat_at ?? null,
    used_slots: used,
    max_slots: settings.max_parallel,
    evaluated_at: new Date(now).toISOString(),
  };
  if (!settings.enabled) return { ...result, state: 'disabled' };
  const red: string[] = [],
    yellow: string[] = [];
  if (!runtime) {
    (enabledAt && now - Date.parse(enabledAt) >= 300_000 ? red : yellow).push('installation_pending');
  } else {
    const age = now - Date.parse(runtime.heartbeat_at);
    if (!Number.isFinite(age) || age >= 90_000) red.push('heartbeat_expired');
    else if (!runtime.connected || age >= 45_000) yellow.push('reconnecting');
    if (runtime.error) red.push(runtime.error);
    if (runtime.username !== settings.username) red.push('service_user_mismatch');
    const ready = engines.filter((e) => runtime.engines.includes(e));
    if (!ready.length) red.push('no_engine_ready');
    else if (ready.length < engines.length) yellow.push('engines_partially_ready');
  }
  if (used >= settings.max_parallel) yellow.push('busy');
  result.state = red.length ? 'red' : yellow.length ? 'yellow' : 'green';
  result.reasons = [...red, ...yellow];
  return result;
}
export const daemonStartSchema = z
  .object({
    host_id: z.number().int().positive(),
    engine: z.enum(['codex', 'claude', 'grok']),
    cwd: z.string().max(1024).optional(),
    title: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(100_000),
    client_message_id: z.string().uuid(),
  })
  .strict();
