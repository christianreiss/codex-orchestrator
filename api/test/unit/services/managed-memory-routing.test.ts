import { describe, expect, it } from 'vitest';
import { buildManagedMemoryRouting } from '../../../src/services/managed-memory-routing.js';

describe('native memory reminder', () => {
  it('names central read/write tools and fits native startup index limits', () => {
    const result = buildManagedMemoryRouting(true);
    expect(result.enabled).toBe(true);
    for (const tool of ['shared_memory_list', 'shared_memory_search', 'shared_memory_read',
      'shared_memory_write', 'shared_memory_append', 'project_memory_upsert', 'expected_sha256']) {
      expect(result.content).toContain(tool);
    }
    expect(result.content.split('\n').length).toBeLessThan(25);
    expect(Buffer.byteLength(result.content)).toBeLessThan(2048);
  });
  // The #coco skill tells agents to avoid project_bootstrap (it inlines every
  // body); this reminder lands in every native memory file and must agree.
  // It is fleet text served to every installation, so its heading is English.
  it('points project context at the lean tools #coco recommends', () => {
    const { content } = buildManagedMemoryRouting(true);
    expect(content).toContain('project_summary');
    expect(content).not.toContain('project_bootstrap');
    expect(content.split('\n')[0]).toBe('## Reminder: Codex Orchestrator memory');
  });
  it('does not advertise unavailable tools', () => {
    expect(buildManagedMemoryRouting(false)).toEqual({ enabled: false, content: '' });
  });
});
