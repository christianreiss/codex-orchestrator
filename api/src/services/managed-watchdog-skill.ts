import { createHash } from 'node:crypto';
import type { ManagedSkillManifest } from './managed-context-skill.js';
const description =
  'Enable, inspect and stop bounded recovery for your current task after capacity, crash or hang; server keep-alives run independently of the model.';
const manifest = `---
name: watchdog
description: "${description}"
---

# Watchdog

Use watchdog_get, watchdog_enable, watchdog_disable and watchdog_finish from the
session-scoped cxx-agent MCP. You may enable recovery for your own current authorized
task when useful; announce the target and deadline. Another agent requires explicit
user selection through CLI/admin. This never widens task authority.

1. Read watchdog_get first. Reuse an active watchdog for the same task.
2. Enable with a stable task_key and a concise continuation describing the current
   authorized task and acceptance criteria. Defaults: duration_seconds=7200,
   progress_timeout_seconds=600. Report the returned deadline and any error.
3. Inspect with watchdog_get, optionally id. Keep-alives every 15 seconds are wrapper
   transport, not model turns or progress. Capacity retry starts after five minutes,
   backs off with positive jitter and respects later provider reset times.
4. When the task ends, use watchdog_finish with id, current version and status:
   succeeded, failed, blocked or unknown. For accepted work also report its normal
   agent_task_result/agent_reply; watchdog_finish does not replace that receipt.
5. Use watchdog_disable with id and version to stop recovery. Honor user STOP.
   A new task needs a new task_key; enable retries do not extend the deadline.

Only the same engine/native transcript/cwd is resumed. Missing transcripts block;
never create a replacement. Active tools and open user questions are protected.
Recovery after ambiguous crashes can repeat effects; preserve idempotency checks.
Deadline stops future recovery, not accepted running work. AI activation is scoped
by the current bridge; operator CLI/admin can select another target explicitly.
CLI: cxx watchdog status|on|off (cdx/clx/cgx aliases also work). Portal is read-only.
`;
export const isManagedWatchdogSlug = (s: string) => s.trim().toLowerCase() === 'watchdog';
export function buildManagedWatchdogSkill(updatedAt: string): ManagedSkillManifest {
  return {
    slug: 'watchdog',
    display_name: 'Watchdog',
    description,
    manifest,
    sha256: createHash('sha256').update(manifest).digest('hex'),
    updated_at: updatedAt,
    deleted_at: null,
    engine: null,
    uri: 'skill://watchdog',
    canonical_uri: 'skill://watchdog',
    managed: true,
  };
}
