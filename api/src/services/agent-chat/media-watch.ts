import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { wsPublisher } from '../../ws/publisher.js';

/** The worker atomically publishes processing.json. Wake interested views on
 * that event; no interval, directory rescan or SQL lookup is needed. */
export async function startMediaResultWatch(
  root: string,
  options: { changed?: (id: string) => void; error: (error: unknown) => void },
): Promise<() => void> {
  const directory = join(root, 'agent-chat');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pending = new Set<string>();
  let queued = false,
    closed = false;
  const watcher = watch(directory, { recursive: true, persistent: false }, (_event, name) => {
    if (closed || !name) return;
    const path = String(name),
      id = basename(dirname(path));
    if (
      basename(path) !== 'processing.json' ||
      !/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(id)
    )
      return;
    pending.add(id);
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (closed) return;
      for (const id of pending)
        try {
          if (options.changed) options.changed(id);
          else wsPublisher.publish('agent_chat.attachment.changed', { id });
        } catch (error) {
          options.error(error);
        }
      pending.clear();
    });
  });
  watcher.on('error', options.error);
  return () => {
    closed = true;
    pending.clear();
    watcher.close();
  };
}
