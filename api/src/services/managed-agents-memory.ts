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
 * Kept deliberately short. This text is prepended to every session on every host
 * for both engines, so every line costs context on every run.
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
      'index) is host-local. Do not use it for anything durable or shared, and do not mirror',
      'orchestrator memory into it. Use it only for notes that are genuinely about this one machine.',
    ].join(' ');
  }
  return [
    'Local scratch files under the Codex home (and any ad-hoc notes file) are host-local.',
    'Do not use them for anything durable or shared, and do not mirror orchestrator memory into them.',
  ].join(' ');
}

export function buildManagedMemoryBlock(engine: Engine): string {
  return `${MANAGED_MEMORY_HEADING}

Durable memory lives in the orchestrator over MCP, not in local files. ${localMemoryOverride(engine)}

Three stores, and they are not interchangeable:

- \`shared_memory_*\` — **fleet-wide documents**. Runbooks, architecture notes, accumulated findings:
  anything the next agent on a different host or a different project would want. Not scoped to a host
  or a project. Start with \`shared_memory_list\` (it needs no query) to see what the fleet already
  knows, narrow with \`shared_memory_search\`, read with \`shared_memory_read\`. Add to an existing
  document with \`shared_memory_append\` rather than read-modify-write — other agents write here too.
- \`project_memory_*\` — short facts about one workstream, keyed \`<area>.<topic>\`. Needs a project
  slug. Enumerate with \`project_memory_list\`.
- \`memory_*\` — host-local scratch, tied to this machine. It cannot be listed, so nobody else can
  discover what it holds. Never use it for anything another agent needs.

When work will outlive this session, check \`shared_memory_list\` before starting and record what you
learned before finishing. Never store secrets — keys, tokens, credentials, customer data — in any of
them.
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
