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
      expect(block.toLowerCase()).toContain('not in local files');
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

  it('stays small enough to prepend to every session', () => {
    // This text costs context on every run on every host, for both engines.
    expect(buildManagedMemoryBlock(ENGINE_CLAUDE).length).toBeLessThan(1600);
  });
});
