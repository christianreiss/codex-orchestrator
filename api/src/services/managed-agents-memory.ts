/**
 * The managed memory-routing block appended to the served AGENTS.md / CLAUDE.md.
 *
 * Why this exists at all: shipping a shared memory store is not the same as
 * getting agents to use it. Both engines arrive with a default that wins unless
 * something overrides it — Claude Code has native on-disk memory
 * (`~/.claude/projects/<project>/memory/` plus its `MEMORY.md` index) that it will
 * happily use for durable facts, and Codex reaches for local scratch files. Both
 * are host-local: another host, another agent, and a reinstalled workstation
 * cannot see them, which is exactly the failure the shared store was built to
 * fix. A skill cannot close that gap either, because skills only load when
 * invoked; the agents document is read every session, unprompted.
 *
 * So the routing rule lives here, is appended server-side to whatever canonical
 * document the operator authored, and reaches every host on the next sync.
 *
 * This block also carries the full curation contract — add, update, delete —
 * which used to live in the `#context` skill. Measured over 9354 sessions, that
 * skill was invoked exactly once (a self-test) and `shared_memory_delete` was
 * never called at all: the doctrine was never wrong, it was never *loaded*.
 * Retiring the skill and paying for these lines on every run is the whole point,
 * so resist trimming this back into a stub.
 *
 * The curation trigger is deliberately bound to the READ, not to end-of-task.
 * Traffic runs ~113 reads per 3 writes, so the moment an agent reads a record
 * that contradicts what it just verified is both the commonest moment and the
 * only one where the slug and the truth are already in hand. An end-of-task
 * checkpoint competes with finishing, which is exactly what produced zero
 * corrections.
 */
import { createHash } from 'node:crypto';
import { ENGINE_CLAUDE, type Engine } from '../util/engine.js';

export const MANAGED_MEMORY_HEADING = '## Memory (managed)';

/**
 * The engine-specific sentence naming the local memory this block overrides.
 * Naming the actual path matters: a generic "do not use local files" is easy to
 * read as not applying to a first-class harness feature.
 */
function localMemoryOverride(engine: Engine): string {
  if (engine === ENGINE_CLAUDE) {
    return [
      "Claude Code's built-in file memory (`~/.claude/projects/**/memory/*.md` and its `MEMORY.md`",
      'index) is host-local: another host and a reinstalled workstation cannot see it. Do not use it',
      'for anything durable or shared, and do not mirror orchestrator memory into it.',
    ].join(' ');
  }
  return [
    'Codex\'s own local memories feature and any ad-hoc notes file under the Codex home are',
    'host-local: another host and a reinstalled workstation cannot see them. Do not use them for',
    'anything durable or shared, and do not mirror orchestrator memory into them.',
  ].join(' ');
}

export function buildManagedMemoryBlock(engine: Engine): string {
  return `${MANAGED_MEMORY_HEADING}

This fleet keeps recorded decisions, conventions, runbooks, and handoffs in the orchestrator,
shared across every host and both engines. Treat those records as authoritative over your own
assumptions, not automatically as current code or runtime truth. Verify mutable facts against the
present repository or system.

**Looking something up.** If you are asked about this fleet, a host, a convention, a runbook, or any
past decision — and you do not already know the answer — call \`shared_memory_list\` (it takes no
arguments) or \`shared_memory_search\` **first, before searching the filesystem**. Read the hit with
\`shared_memory_read\`. Saying "I could not find it" without having checked there is a wrong answer:
that is where the answer lives. \`memory_*\` is host-local scratch and is NOT a lookup surface —
it cannot be listed, so it can never tell you what exists.

**When a record is wrong, fix it then.** If something you read here contradicts what you just
verified, correcting it is part of the task you are already doing — not follow-up work. You have the
slug and the truth in hand now; you will not have them later. Rewrite the same slug with
\`shared_memory_write\`, passing \`expected_sha256\` from your read so a concurrent writer fails loudly
instead of losing text. Use \`shared_memory_delete\` when a record is superseded or was proven wrong:
deleting is part of the job, because wrong context is worse than no context. Never leave a corrected
fact standing beside the stale one — near-duplicates are how this corpus rots into uselessness.

**Writing something down.** Anything the next agent — on another host, in another session — would
want belongs in \`shared_memory_write\`, or \`shared_memory_append\` to grow a document that already
exists. Facts about one workstream go in \`project_memory_*\`. Search before you create, and prefer
updating an existing record over minting a near-duplicate slug. Name slugs \`<area>.<topic>\`, like
\`deploy.crane\`. Store the *why*, which the code and git history do not record. Use absolute dates:
"last week" is worthless three sessions later. ${localMemoryOverride(engine)}

Never store secrets — keys, tokens, credentials, customer data — in any of them.
`;
}

export function managedMemoryBlockSha(engine: Engine): string {
  return createHash('sha256').update(buildManagedMemoryBlock(engine)).digest('hex');
}

/**
 * Append the managed block to a canonical document, separated by a blank line
 * and idempotent: a canonical body that already carries the heading (because an
 * operator pasted a served copy back into the editor) is returned untouched
 * rather than gaining a second copy.
 */
export function appendManagedMemoryBlock(body: string, engine: Engine): string {
  if (body.includes(MANAGED_MEMORY_HEADING)) return body;
  const trimmed = body.replace(/\s+$/, '');
  return trimmed === '' ? buildManagedMemoryBlock(engine) : `${trimmed}\n\n${buildManagedMemoryBlock(engine)}`;
}
