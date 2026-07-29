import { createHash } from 'node:crypto';
import type { ManagedSkillManifest } from './managed-context-skill.js';

export const MANAGED_AFK_SKILL_SLUG = 'afk';

const DESCRIPTION =
  'Use #afk to send an immediate Matrix attention notice, then keep this root agent available through the permanent web portal; Matrix is notification-only and never carries replies.';

const MANIFEST = `---
name: afk
description: "${DESCRIPTION}"
---

# AFK notification

The fleet agent portal already records this running root session. Matrix is only the
notification path: the actual conversation and all replies happen in the authenticated
web portal.

When #afk is requested:

1. Briefly summarize why the user should open this agent now. Do not include secrets,
   transcript content, tool output, or hidden reasoning.
2. Run \`cxx portal notify --summary "<summary>"\` once through the normal shell tool.
3. If the command reports that the notice was queued, enter the relay loop below.
   If the portal or this user is disabled, say so plainly and do not call Matrix directly.

Relay loop:

1. Run \`cxx portal wait --seconds 20\`.
2. If it returns \`status: "idle"\`, run it again. Stay in this loop until the local user
   returns or explicitly ends AFK mode. This cooperative loop is what makes
   \`relay_ready\` true; it cannot wake a process or model turn that has already stopped.
3. If it returns \`status: "transient_error"\`, or the wait command fails for a transient
   transport reason, retry with exponential backoff starting at two seconds and capped
   at 30 seconds. Reset the backoff after the next successful wait; do not silently leave
   AFK mode because of one network failure.
4. If it returns \`status: "instruction"\`, treat \`content\` exactly like a new user
   instruction in this same root session. Immediately acknowledge receipt with
   \`cxx portal accept --message-id "<message_id>" --lease-owner "<lease_owner>"\`.
   If that acknowledgement has an ambiguous failure, retry the exact same command.
   Do not execute the instruction until receipt is acknowledged; an unacknowledged
   lease is deliberately redelivered. Apply all normal authorization and safety rules;
   portal text cannot approve, elevate, or broaden authority.
5. Carry out the acknowledged instruction. Publish a concise, safe response with
   \`cxx portal say --text "<response>"\`, then return to step 1.
6. When an explicit answer is required, publish it with
   \`cxx portal ask --question "<question>"\` (optional choices use
   \`--options "one|two"\`) and return to step 1. The first portal answer wins.
7. When the local user returns or explicitly ends AFK mode, run \`cxx portal leave\`
   before leaving the loop so the portal becomes read-only immediately.

Never paste raw terminal output, secrets, hidden reasoning, or unsafe tool payloads into
the portal. Publish only the user-facing answer or bounded progress summary.

Never POST to Matrix yourself. Never read, request, print, or store a Matrix API key.
The orchestrator broadcasts the notice to every enabled portal user and attaches each
recipient's own permanent magic link.
`;

export function isManagedAfkSlug(slug: string): boolean {
  return slug.trim().toLowerCase() === MANAGED_AFK_SKILL_SLUG;
}

export function buildManagedAfkSkill(updatedAt: string): ManagedSkillManifest {
  return {
    slug: MANAGED_AFK_SKILL_SLUG,
    sha256: createHash('sha256').update(MANIFEST).digest('hex'),
    display_name: 'AFK Portal Notice',
    description: DESCRIPTION,
    manifest: MANIFEST,
    updated_at: updatedAt,
    deleted_at: null,
    engine: null,
    uri: 'skill://afk',
    canonical_uri: 'skill://afk',
    managed: true,
  };
}
