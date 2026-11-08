import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NotFoundError, ServiceUnavailableError } from '../http/errors.js';
import type { Engine } from '../util/engine.js';
import { RTK_VERSION } from './rtk.js';

const base = `https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}`;
export const RTK_ARTIFACTS = {
  'linux/amd64': {
    name: 'rtk-oss-x86_64-unknown-linux-musl.tar.gz',
    sha256: 'a28407dc13038bdc9c2a1f5a047b0c636e0c1d495b15523576e2adb992a06a17',
  },
  'linux/arm64': {
    name: 'rtk-oss-aarch64-unknown-linux-musl.tar.gz',
    sha256: '9786c61dbbea704e1468ee7060930d3b45b67f79ba2babfb73463e85340628d9',
  },
  'darwin/amd64': {
    name: 'rtk-oss-x86_64-apple-darwin.tar.gz',
    sha256: '48f8cee63ae0b4853f9a77d7839e62ffcca18ef88c408f8a93d4e69986b1ab82',
  },
  'darwin/arm64': {
    name: 'rtk-oss-aarch64-apple-darwin.tar.gz',
    sha256: '1959bd6d89a729ccdee176b7141490bbe750820f032c74f29a752576f2495254',
  },
} as const;
export function rtkArtifacts(baseUrl: string, engine: Engine) {
  return Object.fromEntries(
    Object.entries(RTK_ARTIFACTS).map(([platform, artifact]) => [
      platform,
      {
        url: `${baseUrl.replace(/\/+$/, '')}/wrapper/v2/rtk/v${RTK_VERSION}/${platform.replace('/', '-')}?engine=${engine}`,
        sha256: artifact.sha256,
      },
    ]),
  );
}
const pending = new Map<string, Promise<Buffer>>();
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function loadRtkArtifact(root: string, platform: string, version: string): Promise<Buffer> {
  if (version !== RTK_VERSION) throw new NotFoundError('Unknown RTK version');
  const artifact = RTK_ARTIFACTS[platform.replace('-', '/') as keyof typeof RTK_ARTIFACTS];
  if (!artifact) throw new NotFoundError('Unsupported RTK platform');
  const path = join(root, RTK_VERSION, artifact.name);
  const current = pending.get(path);
  if (current) return current;
  const operation = (async () => {
    try {
      const bytes = await readFile(path);
      if (digest(bytes) === artifact.sha256) return bytes;
    } catch {
      /* Missing cache is fetched below. */
    }
    try {
      const response = await fetch(`${base}/${artifact.name}`, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok || !response.body) throw new Error('RTK artifact unavailable');
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = response.body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        size += chunk.length;
        if (size > 64 * 1024 * 1024) {
          await reader.cancel().catch(() => undefined);
          throw new Error('RTK artifact exceeds limit');
        }
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (digest(bytes) !== artifact.sha256) throw new Error('RTK artifact digest mismatch');
      await mkdir(join(root, RTK_VERSION), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      return bytes;
    } catch {
      throw new ServiceUnavailableError(
        'Verified RTK artifact is unavailable; retry sync later',
        'rtk_artifact_unavailable',
      );
    }
  })();
  pending.set(path, operation);
  try {
    return await operation;
  } finally {
    pending.delete(path);
  }
}
