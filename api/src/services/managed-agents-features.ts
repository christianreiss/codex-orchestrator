/**
 * Pure, deterministic renderer for the feature guidance appended to served
 * AGENTS.md / CLAUDE.md documents. Capability discovery stays in
 * HostAgentsService; this module only turns resolved feature gates into text
 * and diagnostics.
 */
import { createHash } from 'node:crypto';
import { AUTHENTICATED_PEER_GUIDANCE } from './agent-messaging-guidance.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINE_GROK, ENGINES, type Engine } from '../util/engine.js';
import { buildManagedMemoryBlock, MANAGED_MEMORY_HEADING } from './managed-agents-memory.js';
import { HISTORIC_MANAGED_MEMORY_BLOCKS } from './managed-agents-memory-legacy.js';
import { API_KEYS_IN_CHAT_GUIDANCE } from './api-keys-in-chat.js';
import {
  axisPolicySections,
  DEFAULT_SECURITY_LEVELS,
  renderSecurityPolicyMarkdown,
  type PolicySectionKey,
  type SecurityAxisId,
  type SecurityLevels,
} from './agent-security-levels.js';
import { documentHeadings, type AgentPolicyProvenanceEntry } from './agent-policy-composer.js';
import { RETIRED_AUTHORITY_SENTENCES_LONGEST_FIRST } from './agent-policy-legacy.js';
import {
  normalizeResponseVerbosityLevel,
  renderResponseStyleOverride,
  stripResponseStyleModule,
  type ResponseVerbosityLevel,
} from './agent-response-style.js';
import { REMOTE_EXEC_GUIDANCE } from './remote-exec.js';
import { DEFAULT_GIT_COMMIT_SETTINGS, renderGitCommitGuidance, type GitCommitSettings } from './git-commit-settings.js';


export const MANAGED_FEATURES_START = '<!-- cxx:managed-features:start -->';
export const MANAGED_FEATURES_END = '<!-- cxx:managed-features:end -->';
export const MANAGED_POLICY_START = '<!-- cxx:managed-policy:start -->';
export const MANAGED_POLICY_END = '<!-- cxx:managed-policy:end -->';

export interface ManagedFeatureState {
  enabled: boolean;
  reason: string;
  count?: number;
}

export interface ManagedAgentFeatureContext {
  engine: Engine;
  skills: ManagedFeatureState;
  memory: ManagedFeatureState;
  projects: ManagedFeatureState;
  browseros: ManagedFeatureState;
  secrets: ManagedFeatureState;
  apiKeysInChat: ManagedFeatureState;
  agentMessaging: ManagedFeatureState;
  gitDirector: ManagedFeatureState;
  fileTransfer: ManagedFeatureState;
  remoteExec: ManagedFeatureState;
  gitCommitSettings?: GitCommitSettings;
}

export interface ManagedAgentFeatureSection {
  present: boolean;
  reason: string;
  count?: number;
  sha256?: string;
  transport?: 'mcp' | 'native';
}

export interface ManagedAgentFeatureSections {
  fleet_identity: ManagedAgentFeatureSection;
  safety_floor: ManagedAgentFeatureSection;
  hard_stops: ManagedAgentFeatureSection;
  /** Absent below the levels that grant anything outright. */
  standing_authorizations: ManagedAgentFeatureSection;
  /** Absent at verbosity level 0 (no-op) or when the response_style module is disabled. */
  response_style: ManagedAgentFeatureSection;
  skills: ManagedAgentFeatureSection;
  memories: ManagedAgentFeatureSection;
  /** Compatibility alias for clients that consumed the former memory block. */
  memory_routing: ManagedAgentFeatureSection;
  projects: ManagedAgentFeatureSection;
  browseros: ManagedAgentFeatureSection;
  secrets: ManagedAgentFeatureSection;
  api_keys_in_chat: ManagedAgentFeatureSection;
  agent_messaging: ManagedAgentFeatureSection;
  git_director: ManagedAgentFeatureSection;
  file_transfer: ManagedAgentFeatureSection;
  remote_exec: ManagedAgentFeatureSection;
  git_commit_messages: ManagedAgentFeatureSection;
}

export interface RenderManagedAgentFeaturesResult {
  body: string;
  managed_sha256: string;
  policy_sha256: string;
  features_sha256: string | null;
  sections: ManagedAgentFeatureSections;
  /** Highlightable blocks in document order, for the console's setting links. */
  provenance: AgentPolicyProvenanceEntry[];
  /** Which policy sections each security axis currently contributes to. */
  axis_sections: Record<SecurityAxisId, PolicySectionKey[]>;
}

const POLICY_SECTION_LABELS: Record<PolicySectionKey, string> = {
  fleet_identity: 'Fleet identity',
  safety_floor: 'Precedence and safety floor',
  hard_stops: 'Hard Stop Lines',
  standing_authorizations: 'Standing Authorizations',
};

/**
 * These name host capabilities, not controls on the policy editor. The label
 * says so, because a console that offers to "jump to the setting" for Skills
 * would be pointing at a switch that does not exist on that page.
 */
const FEATURE_SECTION_LABELS: Partial<Record<keyof ManagedAgentFeatureSections, string>> = {
  skills: 'Skills (host capability)',
  memories: 'Memory (host capability)',
  projects: 'Projects / CoCo (host capability)',
  browseros: 'BrowserOS (host capability)',
  secrets: 'Secrets (host capability)',
  api_keys_in_chat: 'API keys in chat (fleet setting)',
  // A fleet setting, not a host capability: there is deliberately no per-host
  // Agent Messaging switch, so the console's jump-to-setting link is correct.
  agent_messaging: 'Agent Messaging (fleet setting)',
  // Also a fleet setting rather than a per-host capability: one switch in the
  // console turns the Director on for every host, so the jump-to-setting link
  // points at a control that exists.
  git_director: 'Git Director (fleet setting)',
  git_commit_messages: 'Git commit messages (fleet setting)',
  // A fleet setting like the two above: one console switch turns the pool on
  // for every host, so the jump-to-setting link points at a control that exists.
  file_transfer: 'File Transfer (fleet setting)',
  // Also one console switch for every host. Unlike its neighbours this one is
  // not an MCP surface: it reaches the wrapper through the signed host config,
  // so a host that has not refreshed its config yet still sees the old value.
  remote_exec: 'Remote execution (fleet setting)',
};

interface RenderedSection {
  text: string;
  metadata: ManagedAgentFeatureSection;
}

const OWN_BLOCK = new RegExp(
  `${escapeRegExp(MANAGED_FEATURES_START)}[\\s\\S]*?${escapeRegExp(MANAGED_FEATURES_END)}[ \\t]*(?:\\r?\\n)?`,
  'g',
);
const OWN_POLICY_BLOCK = new RegExp(
  `${escapeRegExp(MANAGED_POLICY_START)}[\\s\\S]*?${escapeRegExp(MANAGED_POLICY_END)}[ \\t]*(?:\\r?\\n)?`,
  'g',
);

// The old dynamic renderer used engine-specific inventory blocks. A served
// copy can later be pasted into the canonical editor, so replace all four
// variants rather than allowing the old and new guidance to accumulate.
const LEGACY_BLOCK =
  /<!--[ \t]*(cdx|clx):(skills|memories):start[ \t]*-->[\s\S]*?<!--[ \t]*\1:\2:end[ \t]*-->[ \t]*(?:\r?\n)?/g;

// managed-agents-memory.ts predates marker-delimited sections. Remove only
// the exact bytes emitted by that renderer (with or without its final LF).
// A heading-only regex would risk deleting operator-authored rules appended
// below a previously served copy.
//
// Regenerating from the current renderer only ever matches the CURRENT text, so
// every superseded wording is kept as an exact frozen literal in
// managed-agents-memory-legacy.ts. Without those, a canonical document holding a
// copy served under an older text would stop being stripped and the result would
// carry the stale doctrine beside the current one — the very failure the current
// block tells agents to avoid. Longest-first so a shorter entry can never eat a
// prefix of a longer one.
const LEGACY_MEMORY_BLOCKS = [...new Set(
  [
    ...ENGINES.flatMap((engine) => {
      const block = buildManagedMemoryBlock(engine);
      return [block, block.replace(/\n$/, '')];
    }),
    ...HISTORIC_MANAGED_MEMORY_BLOCKS.flatMap((block) => [block, block.replace(/\n$/, '')]),
  ],
)].sort((a, b) => b.length - a.length);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function countMetadata(
  state: ManagedFeatureState,
): Pick<ManagedAgentFeatureSection, 'count'> | Record<string, never> {
  return state.count === undefined ? {} : { count: state.count };
}

function absent(state: ManagedFeatureState): ManagedAgentFeatureSection {
  return {
    present: false,
    reason: state.reason,
    ...countMetadata(state),
  };
}

function present(
  state: ManagedFeatureState,
  text: string,
  transport?: ManagedAgentFeatureSection['transport'],
): RenderedSection {
  return {
    text,
    metadata: {
      present: true,
      reason: state.reason,
      ...countMetadata(state),
      sha256: sha256(text),
      ...(transport === undefined ? {} : { transport }),
    },
  };
}

function skillsSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.skills.enabled) return null;
  if (context.engine === ENGINE_CLAUDE) {
    return present(
      context.skills,
      `## Skills

Fleet Skills are synced as native Claude Code skills under
\`~/.claude/skills/<slug>/SKILL.md\`. Read the matching \`SKILL.md\` when a Skill's description or
trigger applies, and follow its instructions.`,
      'native',
    );
  }
  if (context.engine === ENGINE_GROK) {
    return present(
      context.skills,
      `## Skills

Fleet Skills are synced as native Grok skills under \`~/.grok/skills/<slug>/SKILL.md\`. Read the
matching \`SKILL.md\` when a Skill's description or trigger applies, and follow its instructions.
To create, update, delete, or explain fleet Skills, follow the \`skill-manager\` Skill instead of
\`/create-skill\`.`,
      'native',
    );
  }
  return present(
    context.skills,
    `## Skills

The orchestrator MCP is authoritative for fleet Skills. For a fleet-Skill request, call
\`skill_list\` before consulting host-local Skill copies. For requests to create, update, delete,
or explain the fleet Skill-management workflow, read \`skill://skill-manager\` with \`resource_read\`
and follow it. Use \`skill_retrieve\` for other manifests and \`skill://{slug}/<path>\` for support
files. An unqualified "Skill" means a fleet Skill; do not substitute Codex's built-in
\`skill-creator\`. Higher-level runtime requirements for built-in or system Skills still take
precedence.`,
    'mcp',
  );
}

function memorySection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.memory.enabled) return null;
  // Preserve the established routing contract verbatim; only demote its
  // heading so all feature providers share one managed top-level block.
  const text = buildManagedMemoryBlock(context.engine)
    .replace(MANAGED_MEMORY_HEADING, '## Memory')
    .replace(/\s+$/, '');
  return present(context.memory, text);
}

function projectsSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.projects.enabled) return null;
  return present(
    context.projects,
    `## Projects / CoCo

Project coordination is enabled through MCP. Use \`#coco\` for its managed workflow and
\`project_*\` tools for shared project state, handoffs, and workstream memory. Start by reading
\`project_bootstrap\` for the active project — bootstrap before acting, even when the task looks
self-evident. The same curation rule as Memory applies here: correct a fact with
\`project_memory_upsert\` on the same key rather than adding a near-duplicate beside it.`,
  );
}

function browserOsSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.browseros.enabled || context.engine !== ENGINE_CODEX) return null;
  return present(
    context.browseros,
    `## BrowserOS

A local BrowserOS MCP server is enabled for this Codex host. Use its browser tools when a task
requires interactive browser automation or live page inspection.`,
  );
}

/**
 * One text for all three engines, with no engine branch. Unlike Skills — where
 * Claude Code has a native `~/.claude/skills/` loader to defer to — neither
 * engine ships a credential store of its own, so there is nothing to
 * differentiate and the rendered bytes are identical either way.
 *
 * The block does not enumerate slugs. `docs/interface-cdx.md` pins the contract
 * ("never lists individual Skills, memories, or projects"), enumerating would
 * rewrite every host's document on every secret added or renamed, and writing
 * credential *names* to disk cuts against a feature whose premise is that
 * nothing lands on the host. Making the agent spend one `secret_list` call is
 * the correct trade.
 */
function secretsSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.secrets.enabled) return null;
  return present(
    context.secrets,
    `## Secrets

This fleet keeps working credentials — API tokens, database passwords, service accounts — in the
orchestrator secrets store, shared across every host and all three engines. It is reachable only
through MCP; the orchestrator does not automatically write its values to this machine's disk.

**Needing a credential.** If a task needs a token, key, password, or connection string, call
\`secret_list\` (it takes no arguments) or \`secret_search\` **first — before asking the human, and
before hunting through env files, config files, or shell history**. Read the match with
\`secret_get\`. Asking for a credential the store already holds is a wrong answer: that is where
it lives.

**Checking or storing.** If asked whether the store is available or whether you can save a secret,
call \`secret_list\` first and use its live \`status\` and \`capabilities\`; never infer availability
from a partial tool list. Save a new credential, or rotate one this host owns, with \`secret_store\`.
Retire a credential this host owns with \`secret_delete\`. A capability question is read-only:
never create, rotate, or delete anything without explicit user intent and the required value.

**Using one.** Prefer a tool-native secret parameter. Otherwise use stdin, an inherited file
descriptor, or a process-scoped environment variable. When a task explicitly requires a credential
in a configuration, file, log, or response, write it to the requested destination and avoid
unnecessary copies. Do not enable shell tracing while handling it; sanitize diagnostic subprocess
output, and unset process-scoped secret variables immediately after use.`,
    'mcp',
  );
}

function apiKeysInChatSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.apiKeysInChat.enabled) return null;
  return present(context.apiKeysInChat, API_KEYS_IN_CHAT_GUIDANCE);
}

/**
 * One text for all three engines, with no engine branch: the `agent_*` tools are the
 * same `cxx-agent` stdio server on both, and the block names only the `#call`
 * trigger rather than how each engine loads that Skill, so there is nothing to
 * differentiate.
 *
 * The rendezvous protocol is spelled out here rather than deferred entirely to
 * `#call` because Skills are gated independently — a host can have Agent
 * Messaging on and no readable `call` Skill, and an agent holding ten tools with
 * no stopping rule is exactly how the 17- and 33-turn runaway conversations in
 * the operator manual happened.
 *
 * Tool names come from `AGENT_MESSAGING_TOOLS` (see that module) and are held to
 * it by `test/unit/services/mcp-tool-name-liveness.test.ts`. Signed-config
 * internals like `listen_enabled` are deliberately absent: they are not tools,
 * and `listen_enabled` mirrors the fleet switch anyway, so it is always true
 * whenever this section renders.
 *
 * No line may begin with `- `: `managed-agents-features.test.ts` slices the body
 * from `## Secrets` to the end and asserts no bullet list follows.
 */
function agentMessagingSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.agentMessaging.enabled) return null;
  return present(
    context.agentMessaging,
    `## Agent Messaging

**Launch names.** The server assigns each managed launch a random free German female name,
shared across Codex, Claude and Grok. It is shown as "(Claudia) Task title". Use
\`agent_translate\` with \`value\` to translate a name to its UUID or a UUID to its current/latest
name; \`cxx agent translate Claudia\` and \`cxx agent translate <uuid>\` work in either direction.
Names may be used directly as recipients for messages, requests and conference invitations.
A name is reserved through launch end plus 24 hours, then may identify a different agent.
Keep canonical UUIDs for durable references; queued deliveries retain their original UUID.

**Own identity.** Updated wrappers confirm a name with the server before starting a messaging-enabled
native launch and pass this launch's identity in its model instructions. An outage, exhausted name pool
or mismatched binding blocks the launch. Call \`agent_self\` near startup and after resume or recovery
to obtain your authenticated current name, agent UUID, launch session ID and native binding.
Earlier transcript names and environment hints may be stale; a native bind can change the agent UUID.
Messaging-disabled local launches do not require this handshake.

**Session name.** Near the start of work, call \`agent_session_name\` with a concise,
descriptive name in the operator's language (at most 160 characters). The tool
preserves a known native or previously assigned session name and sets your suggestion
only when none is known. Use the task's purpose, never a host/path or credentials.
This is the main identity on the Android dashboard; host and directory are secondary.
Older wrappers without this tool can continue normally until updated.

**Wake / Cron.** Use the shared \`#wake-cron\` Skill and orchestrator tools:
\`schedule_list\` discovers schedules; \`schedule_get\` reads prompt, version and execution
history; \`schedule_create\` creates a future once/cron/interval wake;
\`schedule_update\` edits or pauses it with \`enabled:false\`; \`schedule_delete\` removes it.
Read before creating to avoid duplicates, and retrieve the current version before
modifying. Use the exact stable agent address, engine and working directory.
The Wake / Cron admin page manages the same fleet records for all three engines.

Repeating wakes and persistent recovery are separate choices. Recovery is OFF
unless the operator explicitly requests resume after crash, hang or capacity, and
supplies a progress timeout. Healthy idle sessions can receive interval wakes;
busy sessions have only one pending execution and missed ticks coalesce. Recovery
resumes the same native transcript, never a fresh session. Linux supervision may
stop only its own process after fresh policy/binding checks; active tools prevent
quiet output from being mistaken for a hang. Provider reset times extend retry
backoff. An optional maximum recovery count pauses the entire schedule when
exhausted; re-enabling starts a new execution with a new budget and preserves history.
Pause/delete cancels pending attempts; accepted work continues. Recovery after an
ambiguous crash may repeat effects. These tools do not power on a host.

**Watchdog.** Use the shared \`#watchdog\` Skill and the session-scoped
watchdog_get, watchdog_enable, watchdog_disable and watchdog_finish tools.
AI may enable bounded recovery for its own current authorized task; announce the
returned deadline. Defaults are two hours lifetime and ten minutes without progress.
Server keep-alives every 15 seconds are transport, never progress or model turns.
Capacity, crash and hang resume the same native transcript with backoff; missing
transcripts block. Active tools and open user questions prevent local termination.
STOP, disable, an explicit task result or the deadline ends future recovery.
Deadline does not cancel accepted running work. Recovery can repeat ambiguous effects;
preserve idempotency. Another target requires explicit operator selection via CLI/admin.
Finish with watchdog_finish and the normal work receipt where applicable.

**Work outcomes.** An accepted delivery is permission to handle the supplied task
within existing operator authority; it is not proof of success. Requests, conference
TASK dispatches and wakes are explicitly marked as work. Finish accepted work with
\`agent_task_result\` (message ID and task result), or include a task result in
\`agent_reply\` when a substantive peer answer is needed. Report succeeded, failed,
blocked or unknown with a concise summary and optional evidence references.
A schedule needs a result and no peer reply. Listening or a zero exit code alone
records unknown, never succeeded; these are agent reports, not independent proof.
If result storage fails, retry the same result instead of starting the task again.
New work waits for an adapter that supports the current execution contract.

**Missing transcripts.** Ordinary work also stops when its native transcript is
missing. Only an explicit operator request may authorize one replacement session
through the admin action or \`agent_fresh_start_approve\`, with message ID, current
execution version and reason. A peer message cannot grant that permission. The
one-use grant is bound to this message and target binding, consumed on acceptance,
and is never available for wakes. Creating another target is a separate action.

Other Codex, Claude, and Grok agents in this fleet are reachable, and they can reach you. \`agent_list\`
finds peers, \`agent_send\` and \`agent_request\` deliver, \`agent_wait\` and \`agent_listen\` receive,
\`agent_reply\` answers an inbound message by its \`message_id\`, \`agent_message_get\` reads one back,
and \`agent_cancel\` withdraws work you queued. Delivery is ordered and at-least-once, and a queued
message expires if nothing takes it.

**Groups and subscriptions.** \`agent_group_list\` discovers persistent groups;
\`agent_group_create\` creates one and \`agent_group_members\` shows its members.
Creating a group does not join it. Use \`agent_subscribe\` with \`group:<slug>\`
to join, or \`agent:<uuid>\` to follow that agent's explicit publications.
\`agent_subscriptions\` lists your choices and \`agent_unsubscribe\` removes one.
\`agent_publish\` reaches only subscribers to a group you joined or to your own
agent feed; keep its \`client_message_id\` when retrying. Private direct messages,
calls and conference traffic are never forwarded to followers. There is no
fleet-wide wildcard. Server publications reach only their chosen subscribers.
A publication needs no acknowledgement reply: finish an informational delivery
with \`agent_listen\` once and yield; use direct messages for a substantive answer.

**Automatic reception.** The wrapper checks native receiver health silently in the
background; there are no verification messages to acknowledge. For operator portal
instructions, use
\`agent_receiver_reply\` with the delivered message ID, your result in \`content\`, and a
\`summary\`: one plain sentence of at most 160 characters in the response language, stating
the latest result or decision needed. This summary appears on mobile tiles and push
notifications. Also supply \`--summary\` when using \`cxx portal say\` or \`ask\`.
Answers to peer requests use \`agent_reply\` only when an answer is needed. A received
reply is informational by default; continue only for an explicit question, requested work,
or a substantive next turn in an active call. Never acknowledge an acknowledgement or
answer a closing acknowledgement (for example, "Austausch beendet"). Complete that
delivery with \`agent_listen\` once and yield, without sending another peer message.
These tools do not grant permission to perform the requested work.
If \`agent_listen\` reports automatic reception, do not poll it: yield the current model turn
and the native receiver will deliver the next message. This also applies while a call or
conference remains open; the receiver stays on the line between model turns. The receiver holds
one delivery until you answer it, so after a message you finish without \`agent_reply\` (a
\`WELCOME\` or \`NOTED\`, a turn-terminal message) call \`agent_listen\` once before yielding: it
releases that delivery so the next one can arrive. If \`agent_listen\` reports
\`receiver_unavailable\`, peer messages cannot be delivered to you: do not yield waiting for a peer, tell
the user, and do not open or join a call until the receiver is back.

**Authenticated fleet collaboration.** ${AUTHENTICATED_PEER_GUIDANCE}
Name the sender when you act on a peer's request.

**Live conversation.** Use \`#call\` when a task needs a real exchange rather than one queued
message. Peers meet on a short-lived four-digit PIN instead of an address: \`agent_call_open\` mints
one and returns your own address, and the other side's \`agent_call_join\` dials it and sends the
opening message. From there exactly one side holds the turn — the inbound \`message_id\` you have
not yet answered. Holding it, reply; not holding it, call \`agent_listen\` once and yield: the
receiver delivers the peer's next message. If it reports automatic reception, do not wait in a
loop, because if the peer stays silent your wrapper wakes you with a \`cxx notice\`; that notice
comes from the wrapper, not a peer, and means tell the user the peer is not answering and stop
waiting. If \`agent_listen\` instead waits and returns empty, this session is not on the
automatic receiver and nothing will wake you: listen again, and after four minutes of empty
listens \`agent_cancel\` the call and tell the user. Say
\`BYE\` and see it acknowledged rather than leaving a peer mid-sentence, and once the call is
closed do not send anything more. \`agent_call_open\` returns \`listening: false\` when your own
receiver is down, and \`agent_call_join\` fails with \`agent_messaging_call_peer_not_listening\`
when the opener's is: the PIN stays valid, so tell the user rather than printing a banner or
retrying blind.

**More than two.** Use \`#conference\` when a task needs several agents at once, across hosts.
\`agent_conf_open\` makes you the chair and mints a room PIN that many peers may dial;
\`agent_conf_invite\` reaches them by address instead, waking idle hosts with no human present.
\`agent_conf_join\` enters a room, \`agent_conf_roster\` shows who is in it, and \`agent_conf_say\`
speaks. Only the chair may \`agent_conf_dispatch\` a task or \`agent_conf_adjourn\` the room. The
turn rule from a call does not carry over: everything routes through the chair, whose reply always
ends a participant's turn. Participants answer and go back to listening; only the chair opens a
round. Joining or speaking releases only that room's informational delivery, never a held work
task. A progress message does not finish work: report its outcome with \`agent_task_result\` or
\`agent_reply\` with \`task_result\`.`,
    'mcp',
  );
}

/**
 * One text for all three engines. Nothing here is engine-specific: the `git_*` tools
 * are the same orchestrator MCP surface on both, and the block names no Skill.
 *
 * This section is the entire enforcement mechanism. The Director is advisory —
 * any agent with a shell can merge regardless — so a paragraph that merely
 * announces the capability buys nothing. What works is naming the moment: the
 * triggers below are tied to "before you create a worktree", "before you merge
 * or push", because a tool an agent remembers only after the collision is a tool
 * that never fired. The same lesson the Secrets block encodes with "call
 * `secret_list` first — before asking the human".
 *
 * The closing paragraph is deliberate too. An advisory system whose verdicts can
 * be ignored silently decays into one nobody calls; saying out loud that
 * ignoring a `wait` is a reportable choice is cheaper than any hook.
 *
 * No line may begin with `- `: `managed-agents-features.test.ts` slices the body
 * from `## Secrets` to the end and asserts no bullet list follows.
 */
function gitDirectorSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.gitDirector.enabled) return null;
  return present(
    context.gitDirector,
    `## Git Director

Several agents work this fleet's repositories at once, often in separate worktrees of one checkout.
The Director is how they see each other: it keeps a registry of who is working in which clone and
arbitrates merges into shared branches. It is reachable only through MCP and it never touches your
worktree — you run every git command yourself and report what you did.

**Before you start work in a repository.** Call \`git_list\` **first — before creating a worktree, and
before picking up work in a directory you have not registered**. It names the other agents already in
your clone and what each said it is doing. Then \`git_register\` with the facts from
\`git rev-parse --path-format=absolute --show-toplevel --git-common-dir\`, \`git branch --show-current\`, \`git rev-parse HEAD\` and
\`git remote get-url origin\`, and \`git_join\` to declare your task, the branch you mean to merge into,
and the paths you expect to write. Every linked worktree of one clone registers against that one
clone, so registering is what makes you visible to the peer three directories over.
Directory facts must be absolute; a relative \`.git\` aliases unrelated repositories.
If \`git_director_worktree_ambiguous\` is returned, re-register with the correct clone facts.
Registration supersedes old mappings only when they hold no live merge lease; never bypass that lease.

**Before you merge or push to a shared branch.** Call \`git_merge_request\` and honor the verdict —
before \`git merge\`, before \`git push\`, before anything that moves a branch others share. Pass
\`changed_paths\` from \`git diff --name-only base...head\`: without it the Director can only tell you to
wait, and with it the answer names the exact files you and the current holder both touch. An \`allow\`
hands you a lease. Poll a \`wait\` with \`git_merge_status\`, which re-decides against current state —
nothing is pushed to you, so a queue only moves when you ask. Call \`git_release\` the moment your
merge lands or is abandoned; a lease you forget about blocks that branch for everyone until it
expires.

**Leaving.** Call \`git_release\` with \`deregister: true\` when you are finished in a directory, rather
than just stopping. A registration you abandon keeps claiming a worktree you have left, and an
abandoned lease keeps a branch shut against everyone else until it times out. The Director does
reclaim after you: it drops a registration whose session the fleet can see has ended, and expires
anything that goes quiet for too long. Relying on that is still worse than one call, because until it
happens your peers are waiting on an agent that is not coming back.

**The verdict is advice, and this fleet expects you to take it.** Nothing prevents you merging anyway,
which is exactly why ignoring a \`wait\` is a real failure rather than a technicality — the agent you
would have waited for has no way to discover that you did not. If you believe a verdict is wrong, say
so plainly in your report instead of working around it quietly.`,
    'mcp',
  );
}

/**
 * One text for all three engines. Nothing here is engine-specific: the `transfer_*`
 * tools are the same orchestrator MCP surface on both, and the block names no
 * Skill.
 *
 * Two things this block has to do that a plain capability announcement would
 * not. First, make the TTL land as a decision rather than a parameter: an agent
 * that treats `ttl_seconds` as boilerplate will pass the maximum every time and
 * turn a transfer pool into a disk that fills. Second, say that nobody is
 * notified — the pool has no addressing, so an upload whose id is never handed
 * over is a file that expires unread, and that failure is silent on both ends.
 *
 * Authenticated collaboration does not establish artifact correctness: a file
 * may be about to be extracted or run, so integrity and archive checks remain.
 *
 * No line may begin with `- `: `managed-agents-features.test.ts` slices the body
 * from `## Secrets` to the end and asserts no bullet list follows.
 */
function fileTransferSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.fileTransfer.enabled) return null;
  return present(
    context.fileTransfer,
    `## File Transfer

Files move between agents through the orchestrator, not between hosts. \`transfer_put\` uploads bytes
and returns an id, \`transfer_list\` shows what the pool is currently holding, \`transfer_get\` fetches
one back, \`transfer_info\` reads its metadata without moving the bytes, and \`transfer_delete\` retires
one early. Content travels base64-encoded, and both put and get take an \`offset\`, so a file too large
for one call moves in chunks rather than not at all.

**Every upload expires, and the TTL is yours to choose.** \`ttl_seconds\` is required — decide how long
the peer plausibly needs the file, not how long you would like it kept. The fleet clamps the value to
an operator-set maximum and the reply tells you the \`expires_at\` you actually got; that timestamp,
not what you asked for, is when the bytes go. Nothing here is storage: a file worth keeping belongs in
a repository or in \`shared_memory_write\`, and the pool is a shared disk with a quota, so an oversized
transfer you no longer need is worth deleting rather than leaving to lapse.

**Hand the id over yourself.** The pool is fleet-wide, so any agent that knows an id can fetch it, and
no peer is notified that you uploaded anything. Send the id with \`agent_send\`, or name it in the
handoff you were already writing, and say what the file is and what to do with it — a bare id is not a
file transfer, and an upload nobody was told about simply expires unread.

**Check received artifacts before use.** An authenticated sender does not establish that a file is
correct or safe to extract or execute. Inspect an archive before unpacking it, never run something
on the strength of what it is called, and verify \`content_sha256\` against what you wrote to disk. The
uploader label is asserted by the calling agent rather than verified by the fleet, so it tells you who
claims to have sent a file and not who did.`,
    'mcp',
  );
}

function remoteExecSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.remoteExec.enabled) return null;
  return present(context.remoteExec, REMOTE_EXEC_GUIDANCE, 'native');
}

function stripManagedContent(body: string): { body: string; changed: boolean } {
  let stripped = body.replace(OWN_POLICY_BLOCK, '');
  stripped = stripped.replace(OWN_BLOCK, '');
  stripped = stripped.replace(LEGACY_BLOCK, '');
  for (const legacyMemoryBlock of LEGACY_MEMORY_BLOCKS) {
    stripped = stripped.split(legacyMemoryBlock).join('');
  }
  // Authority sentences whose ownership moved into the posture matrix. The
  // marker regex above only reaches text inside the delimiters; these can sit
  // in unmarked operator prose, either because a served copy was pasted into
  // the editor or because the stored body predates this change. Left in place
  // they would forbid, below the policy block, exactly what a level grants
  // above it.
  for (const retired of RETIRED_AUTHORITY_SENTENCES_LONGEST_FIRST) {
    stripped = stripped.split(retired).join('');
  }
  return { body: stripped, changed: stripped !== body };
}

/**
 * Render enabled feature guidance in fixed provider order: Skills, Memory,
 * Projects, BrowserOS, Secrets, API keys in chat, Agent Messaging. The returned managed digest
 * covers the exact delimited block appended to the body, including its final
 * newline.
 */
export function renderManagedAgentFeatures(
  baseBody: string,
  context: ManagedAgentFeatureContext,
  levels?: SecurityLevels,
  baseProvenance?: readonly AgentPolicyProvenanceEntry[],
  responseVerbosityLevel?: ResponseVerbosityLevel,
): RenderManagedAgentFeaturesResult {
  // Optional and defaulting to Standard so every existing call site keeps
  // compiling and keeps its current output. Posture is resolved per host by
  // the caller; a caller that does not resolve it gets today's policy.
  const resolvedLevels = levels ?? DEFAULT_SECURITY_LEVELS;
  const policy = renderSecurityPolicyMarkdown(resolvedLevels);

  // Level 0 is a true no-op: no strip, no override, byte-identical to today.
  // A non-zero level only takes effect if the static module text was actually
  // found — an operator who disabled `response_style` entirely has nothing to
  // override, and injecting one anyway would contradict the disabled module.
  const resolvedVerbosity = normalizeResponseVerbosityLevel(responseVerbosityLevel ?? 0);
  const overrideMarkdown = renderResponseStyleOverride(resolvedVerbosity);
  const strippedBase = overrideMarkdown === null ? { body: baseBody, stripped: false } : stripResponseStyleModule(baseBody);
  const responseStyleActive = overrideMarkdown !== null && strippedBase.stripped;
  baseBody = strippedBase.body;

  const skills = skillsSection(context);
  const memory = memorySection(context);
  const projects = projectsSection(context);
  const browseros = browserOsSection(context);
  const secrets = secretsSection(context);
  const apiKeysInChat = apiKeysInChatSection(context);
  const agentMessaging = agentMessagingSection(context);
  const gitDirector = gitDirectorSection(context);
  const fileTransfer = fileTransferSection(context);
  const remoteExec = remoteExecSection(context);
  const commitText = renderGitCommitGuidance(context.gitCommitSettings ?? DEFAULT_GIT_COMMIT_SETTINGS, context.engine);
  const gitCommitMessages: RenderedSection = {
    text: commitText,
    metadata: { present: true, reason: 'mandatory', sha256: sha256(commitText) },
  };

  const skillsMetadata = skills?.metadata ?? absent(context.skills);
  const memoryMetadata = memory?.metadata ?? absent(context.memory);
  const projectsMetadata = projects?.metadata ?? absent(context.projects);
  const browserOsState =
    context.engine === ENGINE_CODEX
      ? context.browseros
      : { ...context.browseros, enabled: false, reason: 'unsupported_engine' };
  const browserOsMetadata = browseros?.metadata ?? absent(browserOsState);
  // Hash the section's actual rendered bytes. The previous renderer hashed the
  // heading literal, which was constant across every policy revision — harmless
  // while the text was frozen, actively misleading now that it varies by level,
  // because it would report an unchanged sha for changed content.
  const policySection = (text: string | null): ManagedAgentFeatureSection =>
    text === null
      ? { present: false, reason: 'not_at_this_level' }
      : { present: true, reason: 'mandatory', sha256: sha256(text) };
  const sections: ManagedAgentFeatureSections = {
    fleet_identity: policySection(policy.sections.fleet_identity),
    safety_floor: policySection(policy.sections.safety_floor),
    hard_stops: policySection(policy.sections.hard_stops),
    standing_authorizations: policySection(policy.sections.standing_authorizations),
    response_style: responseStyleActive
      ? { present: true, reason: 'level_override', sha256: sha256(overrideMarkdown as string) }
      : { present: false, reason: overrideMarkdown === null ? 'level_0_default' : 'module_disabled' },
    skills: skillsMetadata,
    memories: memoryMetadata,
    memory_routing: memoryMetadata,
    projects: projectsMetadata,
    browseros: browserOsMetadata,
    secrets: secrets?.metadata ?? absent(context.secrets),
    api_keys_in_chat: apiKeysInChat?.metadata ?? absent(context.apiKeysInChat),
    agent_messaging: agentMessaging?.metadata ?? absent(context.agentMessaging),
    git_director: gitDirector?.metadata ?? absent(context.gitDirector),
    file_transfer: fileTransfer?.metadata ?? absent(context.fileTransfer),
    remote_exec: remoteExec?.metadata ?? absent(context.remoteExec),
    git_commit_messages: gitCommitMessages.metadata,
  };

  // Appended last on purpose: provider order is part of `managed_sha256`, so
  // inserting anywhere else would churn every host's document for preceding
  // sections that did not change.
  const orderedFeatures: Array<{ key: keyof ManagedAgentFeatureSections; section: RenderedSection | null }> = [
    { key: 'skills', section: skills },
    { key: 'memories', section: memory },
    { key: 'projects', section: projects },
    { key: 'browseros', section: browseros },
    { key: 'secrets', section: secrets },
    { key: 'api_keys_in_chat', section: apiKeysInChat },
    { key: 'agent_messaging', section: agentMessaging },
    { key: 'git_director', section: gitDirector },
    { key: 'file_transfer', section: fileTransfer },
    { key: 'remote_exec', section: remoteExec },
    { key: 'git_commit_messages', section: gitCommitMessages },
  ];
  const presentFeatures = orderedFeatures.filter(
    (entry): entry is { key: keyof ManagedAgentFeatureSections; section: RenderedSection } =>
      entry.section !== null,
  );
  const renderedSections = presentFeatures.map((entry) => entry.section.text);
  const stripped = stripManagedContent(baseBody);
  const policyMarkdown = responseStyleActive ? `${policy.markdown}\n\n${overrideMarkdown}` : policy.markdown;
  const policyBlock = `${MANAGED_POLICY_START}\n${policyMarkdown}\n${MANAGED_POLICY_END}\n`;
  const managedBlock = renderedSections.length === 0
    ? ''
    : `${MANAGED_FEATURES_START}\n${renderedSections.join('\n\n')}\n${MANAGED_FEATURES_END}\n`;
  // The managed prefix/suffix own the surrounding blank lines. Trimming the
  // canonical middle makes a served document safe to feed back through this
  // renderer without accumulating one blank line per sync.
  const cleaned = stripped.body.trim();
  const middle = cleaned === '' ? '' : `\n${cleaned}\n`;
  const tail = managedBlock === '' ? '' : `\n${managedBlock}`;

  // Same order as the body above: policy block, canonical middle, feature block.
  // A caller that composed the middle hands its entries in; a legacy body is
  // arbitrary operator prose with no per-section attribution to be had, so the
  // whole of it becomes one block pointing back at the raw editor.
  const provenance: AgentPolicyProvenanceEntry[] = [];
  for (const key of ['fleet_identity', 'safety_floor', 'hard_stops', 'standing_authorizations'] as const) {
    const text = policy.sections[key];
    if (text !== null) {
      provenance.push({
        key: `policy:${key}`,
        label: POLICY_SECTION_LABELS[key],
        group: 'policy',
        headings: documentHeadings(text),
      });
    }
  }
  if (responseStyleActive) {
    provenance.push({
      key: 'policy:response_style',
      label: 'Default Response Shape',
      group: 'policy',
      headings: documentHeadings(overrideMarkdown as string),
    });
  }
  if (baseProvenance !== undefined) provenance.push(...baseProvenance.map((entry) => ({ ...entry })));
  else if (cleaned !== '') {
    provenance.push({
      key: 'legacy_document',
      label: 'Legacy Markdown document',
      group: 'legacy',
      headings: documentHeadings(cleaned),
    });
  }
  for (const entry of presentFeatures) {
    provenance.push({
      key: `feature:${entry.key}`,
      label: FEATURE_SECTION_LABELS[entry.key] ?? entry.key,
      group: 'feature',
      headings: documentHeadings(entry.section.text),
    });
  }

  return {
    body: `${policyBlock}${middle}${tail}`,
    managed_sha256: sha256(`${policyBlock}${managedBlock}`),
    policy_sha256: sha256(policyBlock),
    features_sha256: managedBlock === '' ? null : sha256(managedBlock),
    sections,
    provenance,
    axis_sections: axisPolicySections(policy),
  };
}
