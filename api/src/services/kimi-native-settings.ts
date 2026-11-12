import { ValidationError } from '../http/errors.js';
import { renderGrokNativeToml } from './grok-native-settings.js';

const ROOTS = new Set([
  'default_model',
  'default_permission_mode',
  'default_plan_mode',
  'merge_all_available_skills',
  'extra_skill_dirs',
  'extra_agent_dirs',
  'builtin_product_skills',
  'telemetry',
  'auto_session_title',
  'disable_feedback_survey',
  'providers',
  'models',
  'secondary_model',
  'thinking',
  'loop_control',
  'token_counting',
  'task',
  'subagent',
  'swarm',
  'mcp',
  'identity',
  'tools',
  'read',
  'image',
  'database',
  'watch',
  'workspace',
  'experimental',
  'services',
  'permission',
  'environments',
  'hooks',
]);
export function normalizeKimiNativeSettings(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError('Kimi native_settings must be an object', {
      param: 'settings.native_settings',
    });
  for (const key of Object.keys(value))
    if (!ROOTS.has(key))
      throw new ValidationError(`Unsupported Kimi native setting: ${key}`, {
        param: `settings.native_settings.${key}`,
      });
  const out = structuredClone(value) as Record<string, unknown>;
  const mode = out.default_permission_mode;
  if (mode !== undefined && !['manual', 'yolo', 'auto'].includes(String(mode)))
    throw new ValidationError('Kimi permission mode must be manual, yolo or auto', {
      param: 'settings.native_settings.default_permission_mode',
    });
  if (
    out.hooks !== undefined &&
    (!Array.isArray(out.hooks) ||
      out.hooks.some(
        (h) => !h || typeof h !== 'object' || typeof h.event !== 'string' || typeof h.command !== 'string',
      ))
  )
    throw new ValidationError('Kimi hooks require event and command', {
      param: 'settings.native_settings.hooks',
    });
  return out;
}
/** Same TOML encoding primitives; Kimi's schema and ownership are independent. */
export const renderKimiNativeToml = renderGrokNativeToml;
export function kimiNativeOwnedPaths(value: Record<string, unknown>): string[] {
  const paths: string[] = [];
  function walk(value: unknown, path: string[]) {
    if (path[0] === 'mcp_servers' && path.length === 2) paths.push(`mcp_servers.${path[1]}`);
    else if (value && typeof value === 'object' && !Array.isArray(value))
      for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
    else if (path.length)
      paths.push(path.some((p) => p.includes('.')) ? `json:${JSON.stringify(path)}` : path.join('.'));
  }
  walk(value, []);
  return paths;
}
