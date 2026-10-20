import { createHash } from 'node:crypto';
import type { ManagedSkillManifest } from './managed-context-skill.js';

const description =
  'Prepare an operator-authorized Linux reboot and continue the exact native task once; inspect or recover a planned reboot handoff.';
const manifest = `---
name: reboot-safe
description: "${description}"
---

# Planned reboot

Use the session-scoped agent_reboot and agent_reboot_status tools. Codex, Claude
and Grok share this lifecycle; cdx/clx/cgx reboot are the equivalent CLI surface.
This Skill documents the handoff and grants no permission to reboot a host.

## Prepare

1. Confirm the operator authorized this host's reboot. Read agent_self and
   agent_reboot_status; preserve the agent UUID, native transcript ID and existing
   request ID. Inspect the current host boot ID and pending local job with
   cxx reboot status. Only one pending job is supported per host.
2. Verify Linux/systemd, root or passwordless sudo, an active cron.service or
   crond.service, and the existing native transcript. Read #watchdog and #wake-cron
   before inspecting their tools. Disable competing watchdog and enabled persistent
   Wake recovery for this address; retain ordinary schedules and accepted work IDs.
3. Finish or checkpoint in-flight effects. If resource claims protect the task,
   confirm operations ended and release them with their true outcome before boot;
   mark uncertain effects unknown. Claims are not reboot-persistent cluster locks.
   If the task requires exclusive maintenance ownership, keep disruptive work held
   until its supported ownership mechanism is available. A disabled coordination
   feature is not permission to substitute a board claim or a home-made lock.
4. Write a continuation of at most 32 KiB: authorized scope, completed effects,
   pending checks, original work message/claim IDs, repository/branch/HEAD and
   recovery constraints. Keep credentials out. Generate one request UUID and call
   agent_reboot with request_id, reason and continuation. On an uncertain response,
   inspect server and local status; reuse the identical UUID/body for a safe retry.
   A changed body requires reconciliation, not a new reboot request.

## Continue after boot

1. Read agent_self, agent_reboot_status and local cxx reboot status --id UUID.
   Verify a new host boot ID and the same native transcript, user and working
   directory. The agent UUID is retained; the launch binding changes. Refresh the
   session name and agent_context_get, reconcile workflow bindings when present,
   and recheck repository HEAD and task ownership before any further mutation.
2. Reconcile previous resource claims with resource_claim_status when enabled.
   Expired or unknown claims remain uncertain: confirm effects ended, or involve
   the operator. Acquire valid ownership for remaining work; a reboot does not
   authorize taking over another holder's resources.
3. Continue only the checkpoint's unfinished authorized work. Verify service health
   and the task's acceptance criteria, then store the explicit original
   agent_task_result/agent_reply or Portal result. A boot or zero exit is not proof
   of task success.

## Failure

The boot hook consumes its journal and removes cron before native startup. A
consumed native transcript can never be automatically rearmed, even with a new
request ID. Missing transcripts or startup failures require operator intervention;
retain the journal and resume the same transcript only on explicit instruction.
Inspect cxx reboot status --id UUID and the private local journal/log under
/var/lib/cxx/reboot-resume/. Avoid publishing their contents without sanitizing.
cxx reboot disarm --id UUID removes an unconsumed hook, but cannot cancel an OS
reboot already submitted. Keep uncertain accepted work unknown until verified.
`;

export const isManagedRebootSafeSlug = (slug: string) => slug.trim().toLowerCase() === 'reboot-safe';

export function buildManagedRebootSafeSkill(updatedAt: string): ManagedSkillManifest {
  return {
    slug: 'reboot-safe',
    display_name: 'Planned Reboot',
    description,
    manifest,
    sha256: createHash('sha256').update(manifest).digest('hex'),
    updated_at: updatedAt,
    deleted_at: null,
    engine: null,
    uri: 'skill://reboot-safe',
    canonical_uri: 'skill://reboot-safe',
    managed: true,
  };
}
