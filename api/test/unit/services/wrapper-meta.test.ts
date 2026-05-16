import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createWrapperBinRegistry } from '../../../src/services/wrapper-bin-registry.js';
import { createWrapperMetaService } from '../../../src/services/wrapper-meta.js';

const BIN_ROOT = resolve(import.meta.dirname, '..', '..', 'fixtures', 'wrapper-v2', 'bin');

describe('wrapper-meta', () => {
  it('returns the current binary descriptor for a platform', async () => {
    const meta = createWrapperMetaService({
      binaries: createWrapperBinRegistry({ binRoot: BIN_ROOT }),
      schemaVersion: 1,
    });
    const r = await meta.forPlatform('codex', 'linux', 'amd64', 'https://x.example.com');
    expect(r).not.toBeNull();
    expect(r!.version).toBe('1.0.1');
    expect(r!.platform).toBe('linux-amd64');
    expect(r!.binary_url).toBe(
      'https://x.example.com/wrapper/v2/bin/codex/linux-amd64/v1.0.1/cdx',
    );
  });

  it('returns null when no build is published for the requested platform', async () => {
    const meta = createWrapperMetaService({
      binaries: createWrapperBinRegistry({ binRoot: BIN_ROOT }),
      schemaVersion: 1,
    });
    expect(await meta.forPlatform('codex', 'plan9', 'mips64', 'https://x.example.com')).toBeNull();
  });

  it('builds an engine-level meta with all platforms', async () => {
    const meta = createWrapperMetaService({
      binaries: createWrapperBinRegistry({ binRoot: BIN_ROOT }),
      schemaVersion: 1,
    });
    const r = await meta.forEngine('codex', 'https://x.example.com/');
    expect(r.engine).toBe('codex');
    expect(r.schema_version).toBe(1);
    expect(Object.keys(r.platforms).sort()).toEqual(['darwin-arm64', 'linux-amd64']);
  });

  it('builds clx engine meta with /clx file name', async () => {
    const meta = createWrapperMetaService({
      binaries: createWrapperBinRegistry({ binRoot: BIN_ROOT }),
      schemaVersion: 1,
    });
    const r = await meta.forEngine('claude', 'https://x.example.com/');
    expect(r.platforms['linux-amd64']!.url_path).toContain('/clx');
  });

  it('trims trailing slashes from baseUrl', async () => {
    const meta = createWrapperMetaService({
      binaries: createWrapperBinRegistry({ binRoot: BIN_ROOT }),
      schemaVersion: 1,
    });
    const r = await meta.forPlatform('codex', 'linux', 'amd64', 'https://x.example.com///');
    expect(r!.binary_url.startsWith('https://x.example.com/wrapper/v2/')).toBe(true);
  });
});
