import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { acquireStorageOwnership } from '../../../src/control-plane/storage-owner.js';

describe('application storage ownership', () => {
  it('keeps storage excluded while effects drain despite an earlier cleanup rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storage-owner-drain-'));
    const lease = await acquireStorageOwnership(root),
      app = Fastify();
    let release!: () => void, observed!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failed = new Promise<void>((resolve) => {
      observed = resolve;
    });
    app.addHook('onClose', async () => {
      await lease.close();
    });
    app.addHook('onClose', async () => {
      await gate;
      await writeFile(join(root, 'effect'), 'drained');
    });
    app.addHook('onClose', async () => {
      observed();
      throw new Error('cleanup failed');
    });
    await app.ready();
    const closing = app.close().then(
      () => null,
      (error) => error as Error,
    );
    try {
      await failed;
      await expect(acquireStorageOwnership(root)).rejects.toThrow('still owns application storage');
      release();
      expect((await closing)?.message).toBe('cleanup failed');
      expect(await readFile(join(root, 'effect'), 'utf8')).toBe('drained');
      const replacement = await acquireStorageOwnership(root);
      await replacement.close();
    } finally {
      release();
      await closing;
      await lease.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('holds the kernel lock after the acquiring helper exits and never unlinks its inode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storage-owner-'));
    const first = await acquireStorageOwnership(root);
    try {
      const inode = (await stat(join(root, '.control-plane-owner.lock'))).ino;
      await expect(acquireStorageOwnership(root)).rejects.toThrow('still owns application storage');
      await first.close();
      const next = await acquireStorageOwnership(root);
      try {
        expect((await stat(join(root, '.control-plane-owner.lock'))).ino).toBe(inode);
      } finally {
        await next.close();
      }
    } finally {
      await first.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses takeover while a stopped old process could resume an effect, and releases on process death', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storage-owner-process-'));
    const moduleUrl = new URL('../../../src/control-plane/storage-owner.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `const { acquireStorageOwnership } = await import(${JSON.stringify(moduleUrl)});
       const lease = await acquireStorageOwnership(process.argv[1]);
       process.stdout.write('locked'); process.stdin.resume();
       process.stdin.on('end', async () => { await lease.close(); process.exit(0); });`,
        root,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const ended = once(child, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', (data) =>
          String(data) === 'locked' ? resolve() : reject(new Error('Unexpected lock helper output')),
        );
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Storage owner exited before acquiring')));
      });
      child.kill('SIGSTOP');
      await expect(acquireStorageOwnership(root)).rejects.toThrow('still owns application storage');
      child.kill('SIGKILL');
      await ended;
      const next = await acquireStorageOwnership(root);
      await next.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await ended;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
