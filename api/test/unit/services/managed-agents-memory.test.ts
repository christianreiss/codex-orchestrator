/**
 * The managed memory block is the only place that tells an agent to use the
 * MCP-backed stores at all, and it is the only such instruction both engines
 * read unprompted on every session. If these assertions go soft, the shared
 * corpus quietly stops being used and nothing else fails.
 */
import { describe, it, expect } from 'vitest';
import {
  MANAGED_MEMORY_HEADING,
  appendManagedMemoryBlock,
  buildManagedMemoryBlock,
  managedMemoryBlockSha,
} from '../../../src/services/managed-agents-memory.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../../../src/util/engine.js';

describe('managed memory block', () => {
  it('routes durable memory to the MCP tools for both engines', () => {
    for (const engine of [ENGINE_CODEX, ENGINE_CLAUDE]) {
      const block = buildManagedMemoryBlock(engine);
      expect(block).toContain('shared_memory_list');
      expect(block).toContain('shared_memory_search');
      expect(block).toContain('shared_memory_read');
      expect(block).toContain('shared_memory_append');
      expect(block).toContain('project_memory_*');
      expect(block).toContain('memory_*');
      // The block must be directive about LOOKUP, not just storage: an agent
      // that never thinks to search shared memory is the failure mode here.
      expect(block).toMatch(/before searching the filesystem/i);
      expect(block).toMatch(/host-local/i);
    }
  });

  // The specific failure this guards: Claude Code ships its own on-disk memory
  // feature that wins by default. A generic "avoid local files" does not read as
  // covering a first-class harness feature, so the path is named outright.
  it('names Claude Code’s native file memory explicitly on the claude path', () => {
    const claude = buildManagedMemoryBlock(ENGINE_CLAUDE);
    expect(claude).toContain('~/.claude/projects');
    expect(claude).toContain('MEMORY.md');
    expect(claude).toMatch(/do not mirror/i);
  });

  it('does not tell a Codex host about Claude-only paths', () => {
    const codex = buildManagedMemoryBlock(ENGINE_CODEX);
    expect(codex).not.toContain('~/.claude');
    expect(codex).not.toContain('MEMORY.md');
    expect(codex).toMatch(/host-local/i);
  });

  it('gives the two engines different blocks and different digests', () => {
    expect(buildManagedMemoryBlock(ENGINE_CODEX)).not.toBe(buildManagedMemoryBlock(ENGINE_CLAUDE));
    expect(managedMemoryBlockSha(ENGINE_CODEX)).not.toBe(managedMemoryBlockSha(ENGINE_CLAUDE));
    expect(managedMemoryBlockSha(ENGINE_CODEX)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('forbids storing secrets in any store', () => {
    expect(buildManagedMemoryBlock(ENGINE_CODEX)).toMatch(/never store secrets/i);
  });

  it('keeps recorded decisions authoritative without treating mutable facts as current', () => {
    const block = buildManagedMemoryBlock(ENGINE_CODEX);
    expect(block).toMatch(/recorded decisions, conventions, runbooks, and handoffs/i);
    expect(block).toMatch(/not automatically as current code or runtime truth/i);
    expect(block).toMatch(/verify mutable facts against the\s+present repository or system/i);
  });

  // The whole reason #context was retired into this block: the doctrine only
  // works if it is in front of every run. These assertions are the contract.
  it.each([ENGINE_CODEX, ENGINE_CLAUDE])('binds correction to the read, for %s', (engine) => {
    const block = buildManagedMemoryBlock(engine);
    // Triggered by reading a contradiction, not by an end-of-task checkpoint —
    // a checkpoint competes with finishing, which produced zero corrections.
    expect(block).toMatch(/contradicts what you just\s+verified/i);
    expect(block).toMatch(/part of the task you are already doing/i);
    // Update and delete must both name their tool and their trigger.
    expect(block).toMatch(/rewrite the same slug with\s+`shared_memory_write`/i);
    expect(block).toMatch(/`shared_memory_delete` when a record is superseded or was proven wrong/i);
    expect(block).toMatch(/wrong context is worse than no context/i);
    expect(block).toMatch(/near-duplicates are how this corpus rots/i);
  });

  it.each([ENGINE_CODEX, ENGINE_CLAUDE])('carries the hard rules that %s agents never saw', (engine) => {
    const block = buildManagedMemoryBlock(engine);
    // 0 of 11 agent-authored documents followed the slug convention while it
    // lived in a skill that was loaded once, ever.
    expect(block).toMatch(/search before you create/i);
    expect(block).toMatch(/name slugs/i);
    expect(block).toMatch(/deploy\.crane/);
    expect(block).toMatch(/store the \*why\*/i);
    expect(block).toMatch(/absolute dates/i);
  });

  it('appends after the canonical body, separated by a blank line', () => {
    const out = appendManagedMemoryBlock('# AGENTS.md\n\nHouse rules.\n', ENGINE_CODEX);
    expect(out.startsWith('# AGENTS.md\n\nHouse rules.')).toBe(true);
    expect(out).toContain(`\n\n${MANAGED_MEMORY_HEADING}`);
  });

  it('is idempotent — a served copy pasted back into the editor gains no second block', () => {
    const once = appendManagedMemoryBlock('# AGENTS.md\n', ENGINE_CODEX);
    const twice = appendManagedMemoryBlock(once, ENGINE_CODEX);
    expect(twice).toBe(once);
    expect(twice.split(MANAGED_MEMORY_HEADING)).toHaveLength(2);
  });

  it('serves the block alone when the canonical document is empty', () => {
    expect(appendManagedMemoryBlock('', ENGINE_CLAUDE)).toBe(buildManagedMemoryBlock(ENGINE_CLAUDE));
    expect(appendManagedMemoryBlock('   \n\n', ENGINE_CLAUDE)).toBe(buildManagedMemoryBlock(ENGINE_CLAUDE));
  });

  // The former `< 1600` ceiling was removed deliberately when #context was
  // retired into this block: the doctrine has to be here to be read at all, and
  // a budget that forced it back out into a skill is what produced a corpus with
  // zero corrections in 9354 sessions. The cost is real, so it is asserted rather
  // than ignored — this bound is a smoke alarm for accidental bloat (a pasted
  // duplicate, a runaway loop), not a design constraint to economise against.
  it('stays within a sane order of magnitude for per-session cost', () => {
    for (const engine of [ENGINE_CODEX, ENGINE_CLAUDE]) {
      expect(buildManagedMemoryBlock(engine).length).toBeLessThan(4000);
    }
  });
});
