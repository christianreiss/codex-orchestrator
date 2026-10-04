import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firebaseClientConfig } from '../../../src/services/companion/firebase-config.js';
import type { Env } from '../../../src/env.js';

describe('Firebase Android configuration', () => {
  it('keeps push optional', () => {
    expect(firebaseClientConfig({} as Env)).toBeNull();
  });
  it('selects the matching Android client and refuses a different package', () => {
    const folder = mkdtempSync(join(tmpdir(), 'companion-config-'));
    try {
      const path = join(folder, 'google-services.json');
      const env = { COMPANION_FIREBASE_CONFIG_FILE: path } as Env;
      const config = {
        project_info: { project_id: 'test', project_number: '123' },
        client: [
          {
            client_info: {
              mobilesdk_app_id: '1:123:android:test',
              android_client_info: { package_name: 'io.uggs.orchestrator' },
            },
            api_key: [{ current_key: 'public-test-identifier' }],
          },
        ],
      };
      writeFileSync(path, JSON.stringify(config));
      expect(firebaseClientConfig(env)).toEqual({
        project_id: 'test',
        sender_id: '123',
        app_id: '1:123:android:test',
        api_key: 'public-test-identifier',
      });
      config.client[0]!.client_info.android_client_info.package_name = 'wrong.package';
      writeFileSync(path, JSON.stringify(config));
      expect(() => firebaseClientConfig(env)).toThrow('io.uggs.orchestrator');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
