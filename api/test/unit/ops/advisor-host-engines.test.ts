import { describe, expect, it } from 'vitest';
import { versions } from '../../../src/db/schema.js';
import { advisorHostEngines } from '../../../src/ops/ensure-advisor-host.js';
import { createDbFake } from '../../helpers/db-fake.js';

describe('advisor host engine assignment', () => {
  it('carries every engine while none is being destroyed', async () => {
    expect(await advisorHostEngines(createDbFake(new Map([[versions, []]])) as never)).toBe('codex,claude,grok,kimi');
  });

  it('leaves out an engine with an open destroy request so a reboot after purge cannot bring it back', async () => {
    const db = createDbFake(new Map([[versions, [
      { name: 'grok_engine_disabled', version: '1' },
      { name: 'grok_engine_destroy', version: JSON.stringify({ request_id: 'r1', requested_at: '2026-11-14T19:48:42Z', requested_by: 'ops' }) },
    ]]]));
    expect(await advisorHostEngines(db as never)).toBe('codex,claude,kimi');
  });
});
