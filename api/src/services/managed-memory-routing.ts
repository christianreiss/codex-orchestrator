/** A short reminder for the native memory entrypoints; facts remain in MCP. */
export function buildManagedMemoryRouting(enabled: boolean): { enabled: boolean; content: string } {
  return {
    enabled,
    content: enabled ? `## Erinnerung: Codex Orchestrator memory

Durable fleet memory lives in the Codex Orchestrator, shared across hosts and engines.
Look up relevant context through its MCP tools: shared_memory_list or shared_memory_search,
then shared_memory_read. Use project_bootstrap and project_memory_* for project context.
Save durable fleet knowledge with shared_memory_write or shared_memory_append;
save project facts with project_memory_upsert. Search before creating a new record.
memory_* is host-local scratch, not the shared lookup surface.
Follow the managed AGENTS.md / CLAUDE.md curation rules, including complete reads and
expected_sha256 before replacing shared documents. Never store secrets in memory.
Existing local notes below are preserved; verify mutable facts against current code/runtime.
If MCP is unavailable, report it; do not present local notes as centrally verified context.
` : '',
  };
}
