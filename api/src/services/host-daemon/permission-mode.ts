import { ApiError, ConflictError } from '../../http/errors.js';

/**
 * Per-session native permission mode for host daemon sessions (migration 0118).
 *
 * `plan` is the most restrictive Claude mode (CLAUDE_PERMISSION_MODES_BY_LEVEL[0])
 * and is allowed under every posture, root hosts included: the root clamp only
 * replaces bypassPermissions. `default` passes no flag at all, so the host's
 * rendered, posture-clamped mode applies and a session can never exceed it.
 * Codex has no per-invocation plan mode and is rejected.
 */
export const DAEMON_PERMISSION_MODES = ['plan', 'default'] as const;
export type DaemonPermissionMode = (typeof DAEMON_PERMISSION_MODES)[number];
/** Daemon hello capability a wrapper must report before a plan session is offered to it. */
export const PERMISSION_MODE_VERSION = 1;

/** Engines whose native CLI accepts `--permission-mode plan` per invocation. */
const PLAN_ENGINES = new Set(['claude', 'grok']);

export function permissionModesFor(engine: string, runtimeVersion: number | undefined): DaemonPermissionMode[] {
  return PLAN_ENGINES.has(engine) && (runtimeVersion ?? 0) >= PERMISSION_MODE_VERSION ? ['default', 'plan'] : ['default'];
}

/** Stored form: only `plan` is persisted; `default` and absence both mean no flag. */
export function storedPermissionMode(mode: string | null | undefined): 'plan' | null {
  return mode === 'plan' ? 'plan' : null;
}

/**
 * Admission for a plan-mode request. Codex is a request error (422); a reachable
 * daemon whose wrapper predates the capability is a state conflict (409), so
 * an old wrapper can never silently run a plan session at the host's mode.
 */
export function assertPermissionMode(
  engine: string,
  mode: string | null | undefined,
  runtime: { permission_mode_version?: number } | null | undefined,
) {
  if (mode !== 'plan') return;
  if (!PLAN_ENGINES.has(engine))
    throw new ApiError('Plan mode is not available for Codex sessions', {
      status: 422,
      code: 'permission_mode_engine_unsupported',
      type: 'invalid_request_error',
      param: 'permission_mode',
    });
  if ((runtime?.permission_mode_version ?? 0) < PERMISSION_MODE_VERSION)
    throw new ConflictError(
      'The host daemon wrapper does not support plan mode yet; update cxx to 0.9.146 or newer',
      'permission_mode_unsupported',
    );
}

/** Appended to every turn's prompt while the session is still in plan mode. */
export const PLAN_MODE_ADDENDUM =
  'Plan mode: this session runs in native plan mode, so you may only read and investigate; do not edit files or run state-changing commands. ' +
  'Write a complete, concrete implementation plan. Finish the turn by asking the operator through cxx portal ask with --summary, the full plan in --question, ' +
  '--answer-mode both and --choices \'[{"label":"Approve","value":"approve"},{"label":"Reject","value":"reject"},{"label":"Revise","value":"revise"}]\'. ' +
  'If that tool is unavailable in plan mode, end the turn with the plan as your reply. Do not begin implementation. ' +
  'The operator approves with "Approve plan & execute", which switches this session to normal permissions and resumes it with an execution instruction. ' +
  'On Revise, update the plan and ask again; on Reject, stop.';

/** Sent as the resumed turn after the operator approves the plan. */
export const PLAN_APPROVED_PROMPT =
  'The operator approved your plan. This session now runs with normal permissions. Execute the approved plan now, then report the result through cxx portal say or cxx portal ask with --summary.';

export function planModePrompt(prompt: string, mode: string | null | undefined): string {
  return mode === 'plan' ? `${prompt}\n\n${PLAN_MODE_ADDENDUM}` : prompt;
}
