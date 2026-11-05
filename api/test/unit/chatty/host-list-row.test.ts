import { describe, it, expect } from 'vitest';
import { hostListRow } from '../../../src/services/chatty/tools.js';

describe('Chatty host list rows', () => {
  it('reduces per-host agent instructions to their byte size', () => {
    expect(hostListRow({ id: 1, fqdn: 'a.example', agentsExtra: 'Nur über Port 22 ä' })).toEqual({
      id: 1,
      fqdn: 'a.example',
      agentsExtraBytes: Buffer.byteLength('Nur über Port 22 ä', 'utf8'),
    });
  });
  it('omits empty or absent instructions', () => {
    expect(hostListRow({ id: 2, agentsExtra: null })).toEqual({ id: 2 });
    expect(hostListRow({ id: 3 })).toEqual({ id: 3 });
  });
});
