import { wsPublisher } from '../ws/publisher.js';
import { CXX_ARTIFACT, SUPPORTED_WRAPPER_PLATFORMS, type WrapperBinRegistry } from './wrapper-bin-registry.js';

/**
 * Publishing a cxx release is a manifest drop; nothing else announces it. This
 * watcher compares the `current` entry of every supported platform manifest on
 * an interval and publishes `version.wrapper_published` (payload-free) when any
 * changes, so communicator owners receive an `update_available` trigger. The
 * first scan only records the baseline: an API restart already reaches every
 * owner through its reconnect.
 */
export async function scanWrapperCurrent(binaries: WrapperBinRegistry): Promise<string> {
  binaries.invalidate();
  const parts: string[] = [];
  for (const platform of SUPPORTED_WRAPPER_PLATFORMS) {
    const manifest = await binaries.manifestForPlatform(CXX_ARTIFACT, platform).catch(() => null);
    parts.push(`${platform}=${manifest?.current ?? ''}`);
  }
  return parts.join(',');
}

export function startWrapperPublishWatch(binaries: WrapperBinRegistry, intervalMs = 30_000): () => void {
  let last: string | null = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const current = await scanWrapperCurrent(binaries);
      if (last !== null && current !== last) wsPublisher.publish('version.wrapper_published', {});
      last = current;
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
