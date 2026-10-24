import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { OwnerUnavailableError } from './commands.js';

/** A kernel lock on the shared store outlives database-connection loss.
 * flock operates on an inherited duplicate of our open file description. Its
 * helper exits after acquiring; this process retains the lock through its FD.
 * Never unlink the lock file: another inode would permit overlapping owners.
 */
export async function acquireStorageOwnership(root: string): Promise<{ close(): Promise<void> }> {
  await mkdir(root, { recursive: true });
  const handle = await open(
    join(root, '.control-plane-owner.lock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await lock(handle);
  } catch (error) {
    await handle.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return { close: () => (closing ??= handle.close()) };
}

function lock(handle: FileHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new OwnerUnavailableError(
            code === 73
              ? 'Another API process still owns application storage'
              : `Application storage lock unavailable (${signal ?? code})`,
          ),
        );
    });
  });
}
