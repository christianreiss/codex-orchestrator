import { createHash } from 'node:crypto';
import type { ManagedSkillManifest } from './managed-context-skill.js';
const slug = 'wake-cron';
const description =
  'Create, inspect, modify, pause and delete fleet Wake/Cron schedules; enable persistent native-session recovery only when explicitly requested.';
const manifest = `---
name: wake-cron
description: "${description}"
---

# Fleet Wake / Cron

Use the orchestrator schedule_* tools for agent Wake/Cron requests. This Skill
is shared across Codex, Claude and Grok. Do not edit host crontabs for these jobs.
Every authorized fleet agent can manage all fleet schedules; the admin Wake / Cron
page manages the same records. A Skill does not grant additional authority.

1. Discover the exact target with agent_list, including offline agents when needed.
   Use its stable agent:<uuid> address. Never silently switch to a different target.
2. Call schedule_list before creating to avoid duplicates; follow next_cursor using
   after. Call schedule_get before editing or deleting and use the returned version.
3. schedule_create requires name, target, prompt and kind. Supply exactly one:
   once + at (future RFC3339); cron + cron (five fields); interval + interval_minutes
   (positive integer). timezone defaults to Europe/Berlin, enabled to true.
4. Persistent recovery is OFF by default. Set persistent:true ONLY on an explicit
   request to resume after crash/hang/capacity or an explicitly requested persistent
   wake. A repeating schedule alone is not recovery authorization. Require an
   explicit progress_timeout_seconds (60..604800) for hang recovery; ask for it
   when missing. A known native session and the user's cxx-agent worker are required.
   max_recovery_attempts is optional (null means unlimited); only set a finite limit
   as requested. Backoff doubles from the schedule interval, caps at at least one
   hour, adds up to 20% positive jitter and respects later provider reset times.
   Repeated failures warn after three recovery attempts. Exhausting the limit pauses
   the whole schedule; a later interval cannot bypass it. Re-enable explicitly to
   start a new execution budget, preserving all prior history.
5. Modify through schedule_update with id, version and changed fields. Pause with
   enabled:false. Delete with schedule_delete using id and version.
6. Retrieve again after a write and report the exact target, next time/timezone,
   whether persistent recovery is on, and any waiting/blocked state.

Regular schedules wait for a live receiver. Persistent schedules may resume the
same native session and working directory; they never fall back to a fresh session.
An interval wakes healthy idle sessions too. Busy sessions have at most one pending
wake; missed times are coalesced. Capacity failures wait before retrying. A running
process is stopped only by its own supervisor after the configured progress timeout
and a fresh binding/policy check. Long active tools are not inferred hung from quiet
output. A missing transcript blocks recovery. Recovery after an ambiguous crash can
repeat side effects: never describe it as exactly-once task execution.

Pause/delete prevents further attempts and queued deliveries, while already
accepted work continues. Existing fleet/host/engine switches remain authoritative.
Host power-on is not provided. Delivery acceptance is not proof the task succeeded.
Complete accepted wakes with agent_task_result: status succeeded, failed, blocked
or unknown; summary plus optional evidence references. Do not send a peer reply.
Listen, process exit and transport completion alone mean unknown. Domain failure
alone does not trigger recovery. Inspect task_result_status separately from status.
New work waits on adapter_upgrade_required until a compatible wrapper is present.
Never approve a fresh-start grant for a wake; that action only applies to ordinary
work and requires an explicit operator request.
`;
export function isManagedWakeCronSlug(value: string) {
  return value.trim().toLowerCase() === slug;
}
export function buildManagedWakeCronSkill(updatedAt: string): ManagedSkillManifest {
  return {
    slug,
    display_name: 'Wake / Cron',
    description,
    manifest,
    sha256: createHash('sha256').update(manifest).digest('hex'),
    updated_at: updatedAt,
    deleted_at: null,
    engine: null,
    uri: `skill://${slug}`,
    canonical_uri: `skill://${slug}`,
    managed: true,
  };
}
