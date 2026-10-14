import { describe, expect, it, vi } from 'vitest';
import { startWrapperPublishWatch } from '../../../src/services/wrapper-publish-watch.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import type { WrapperBinRegistry } from '../../../src/services/wrapper-bin-registry.js';

describe('wrapper publish watch', () => {
  it('publishes version.wrapper_published only when a current release changes after the baseline', async () => {
    let current = '0.9.81';
    const registry = {
      invalidate: () => {},
      manifestForPlatform: async () => ({ engine: 'cxx', os: 'linux', arch: 'amd64', current, builds: [] }),
    } as unknown as WrapperBinRegistry;
    const events: string[] = [];
    const unsubscribe = wsPublisher.subscribe((e) => events.push(e.type));
    vi.useFakeTimers();
    try {
      const stop = startWrapperPublishWatch(registry, 1000);
      await vi.advanceTimersByTimeAsync(1100);
      expect(events).not.toContain('version.wrapper_published');
      current = '0.9.82';
      await vi.advanceTimersByTimeAsync(1100);
      expect(events.filter((t) => t === 'version.wrapper_published')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1100);
      expect(events.filter((t) => t === 'version.wrapper_published')).toHaveLength(1);
      stop();
    } finally {
      vi.useRealTimers();
      unsubscribe();
    }
  });
});
