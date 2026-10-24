import { describe, it, expect } from 'vitest';
import { DEFAULT_SERVER_RETENTION, parseServerRetention, retentionRevision, validateServerRetention } from '../../../src/services/server-retention/policy.js';
import { coldTasks } from '../../../src/services/server-retention/cold.js';

describe('server retention policy', () => {
  it('prepares new workers without silently arming destructive cleanup', () => {
    expect(parseServerRetention(null)).toEqual({ audit_days:14, history_hours:24, quota_days:7, armed:false });
    expect(coldTasks('receipts', { ...DEFAULT_SERVER_RETENTION })).toEqual([]);
  });
  it.each([{audit_days:0}, {audit_days:1.5}, {history_hours:87601}, {quota_days:3651}, {armed:'true'}])('rejects invalid settings: %j', patch => {
    expect(() => validateServerRetention({ ...DEFAULT_SERVER_RETENTION, ...patch })).toThrow();
  });
  it('uses a stable, value-sensitive revision and normalizes property order', () => {
    const a = validateServerRetention({ ...DEFAULT_SERVER_RETENTION });
    const b = validateServerRetention({ armed:false, quota_days:7, history_hours:24, audit_days:14 });
    expect(retentionRevision(a)).toBe(retentionRevision(b));
    expect(retentionRevision(a)).not.toBe(retentionRevision({ ...a, audit_days:15 }));
  });
  it('rejects a fake setting instead of pretending to save it',()=>{
    expect(()=>validateServerRetention({...DEFAULT_SERVER_RETENTION,days_mcp:1})).toThrow('Unknown retention setting');
  });
});
