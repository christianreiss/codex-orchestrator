import { describe, expect, it, vi } from 'vitest';
import { appendAuditLog, persistAuditLog } from '../../../src/services/audit-log.js';
import type { Database } from '../../../src/db/client.js';

describe('audit noise suppression', () => {
  it.each(['cron.update_reported', 'cron.update_available', 'agent_message.delivery', 'agent_message.completed'])(
    'does not persist redundant %s observations', async (action) => {
      const insert = vi.fn();
      const db = { insert } as unknown as Database;
      const row = { action, createdAt: new Date().toISOString() };
      await appendAuditLog(db, row);
      await persistAuditLog(db, row);
      expect(insert).not.toHaveBeenCalled();
    },
  );
  it.each(['auth.store', 'auth.validate', 'agent_message.ambiguous', 'agent_message.dead', 'admin.host.insecure_extend'])(
    'retains %s audit records', async (action) => {
      const values = vi.fn(async () => []);
      const insert = vi.fn(() => ({ values }));
      const db = { insert } as unknown as Database;
      const row = { action, createdAt: new Date().toISOString() };
      await appendAuditLog(db, row);
      expect(values).toHaveBeenCalledWith(row);
    },
  );
});
