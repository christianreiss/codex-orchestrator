import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { startMediaResultWatch } from '../../src/services/agent-chat/media-watch.js';
it('observes atomic processing publication in newly created attachment directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-watch-')),
    changed = vi.fn(),
    error = vi.fn();
  const stop = await startMediaResultWatch(root, { changed, error });
  try {
    const id = randomUUID(),
      directory = join(root, 'agent-chat', id);
    await mkdir(directory);
    await writeFile(join(directory, 'processing.tmp'), '{"status":"ready"}');
    await rename(join(directory, 'processing.tmp'), join(directory, 'processing.json'));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(id));
    expect(error).not.toHaveBeenCalled();
    stop();
    changed.mockClear();
    await writeFile(join(directory, 'processing.json'), '{}');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(changed).not.toHaveBeenCalled();
  } finally {
    stop();
    await rm(root, { recursive: true, force: true });
  }
});
