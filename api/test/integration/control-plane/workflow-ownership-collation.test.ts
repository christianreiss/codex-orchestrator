import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import type { RowDataPacket } from 'mysql2/promise';
import { getTestDb } from '../../helpers/test-db.js';
import { reconcileWorkflowOwnership } from '../../../src/control-plane/state/workflow-ownership.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';

const handle = await getTestDb();
describe.skipIf(!handle)('workflow ownership across legacy UUID collations', () => {
  afterAll(async () => { await handle?.pool.end(); });
  it.each([
    ['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'],
    ['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci'],
  ])('preserves exclusions with native %s and workflow %s', async (native, workflow) => {
    const connection = await handle!.pool.getConnection();
    const tables = ['workflow_run_tasks', 'workflow_runs', 'workflow_run_members', 'agent_native_controls'];
    const session = '891f3673-d7e0-4cfb-99e6-a5919a7cf398';
    const address = '591f3673-d7e0-4cfb-99e6-a5919a7cf398';
    const instance = '691f3673-d7e0-4cfb-99e6-a5919a7cf398';
    const run = '791f3673-d7e0-4cfb-99e6-a5919a7cf398';
    try {
      // Connection-local shadows exercise the actual boot SQL without altering
      // the application's tables, their collations, or any existing rows.
      await connection.query(`CREATE TEMPORARY TABLE agent_native_controls (
        session_id CHAR(36), binding_generation INT, instance_id CHAR(36)) CHARACTER SET utf8mb4 COLLATE ${native}`);
      await connection.query(`CREATE TEMPORARY TABLE workflow_run_tasks (
        id VARCHAR(36), claim_owner_address_id CHAR(36), claim_session_id CHAR(36), claim_binding_generation INT,
        claim_ownership_mode VARCHAR(16), claim_native_instance_id CHAR(36), claim_lease_until VARCHAR(40)) CHARACTER SET utf8mb4 COLLATE ${workflow}`);
      await connection.query(`CREATE TEMPORARY TABLE workflow_runs (
        id CHAR(36), coordinator_address_id CHAR(36), coordinator_ownership_mode VARCHAR(16),
        coordinator_session_id CHAR(36), coordinator_binding_generation INT, coordinator_native_instance_id CHAR(36),
        coordinator_lease_until VARCHAR(40), status VARCHAR(16)) CHARACTER SET utf8mb4 COLLATE ${native}`);
      await connection.query(`CREATE TEMPORARY TABLE workflow_run_members (
        run_id CHAR(36), agent_address_id CHAR(36), session_id CHAR(36), binding_generation INT, status VARCHAR(16)) CHARACTER SET utf8mb4 COLLATE ${workflow}`);
      await connection.query('INSERT INTO agent_native_controls VALUES (?,7,?)', [session, instance]);
      await connection.query(`INSERT INTO workflow_run_tasks VALUES
        ('matched',?,?,7,'timed',NULL,'expired'),
        ('unmatched',?,'unknown',7,'timed',NULL,'expired'),
        ('modern',?,?,7,'connection','preserved','preserved'),
        ('unowned',NULL,NULL,NULL,'timed',NULL,'preserved')`, [address, session, address, address, session]);
      await connection.query(`INSERT INTO workflow_runs VALUES
        (?,?,'timed',NULL,NULL,NULL,'expired','running'),
        ('completed',?,'timed',NULL,NULL,NULL,'preserved','completed'),
        ('unmatched',?,'timed',NULL,NULL,NULL,'expired','running'),
        ('modern',?,'connection','preserved',9,'preserved','preserved','running')`, [run, address, address, address, address]);
      await connection.query("INSERT INTO workflow_run_members VALUES (?,?,?,7,'active')", [run, address, session]);
      await expect(connection.query('SELECT n.session_id=t.claim_session_id FROM agent_native_controls n JOIN workflow_run_tasks t ON n.binding_generation=t.claim_binding_generation'))
        .rejects.toMatchObject({ code: 'ER_CANT_AGGREGATE_2COLLATIONS' });
      await expect(connection.query('SELECT m.run_id=r.id FROM workflow_run_members m JOIN workflow_runs r ON m.status=r.status OR r.status=\'running\''))
        .rejects.toMatchObject({ code: 'ER_CANT_AGGREGATE_2COLLATIONS' });
      const tx = drizzle(connection) as unknown as PersistenceTransaction;
      await reconcileWorkflowOwnership(tx);
      await reconcileWorkflowOwnership(tx); // Boot retry must be idempotent.
      const [tasks] = await connection.query<RowDataPacket[]>('SELECT * FROM workflow_run_tasks ORDER BY id');
      expect(tasks.find(row => row.id === 'matched')).toMatchObject({claim_owner_address_id:address,claim_session_id:session,claim_binding_generation:7,claim_ownership_mode:'connection',claim_native_instance_id:instance,claim_lease_until:null});
      expect(tasks.find(row => row.id === 'unmatched')).toMatchObject({claim_owner_address_id:address,claim_session_id:'unknown',claim_ownership_mode:'connection',claim_native_instance_id:null,claim_lease_until:null});
      expect(tasks.find(row => row.id === 'modern')).toMatchObject({claim_native_instance_id:'preserved',claim_lease_until:'preserved'});
      expect(tasks.find(row => row.id === 'unowned')).toMatchObject({claim_owner_address_id:null,claim_ownership_mode:'timed',claim_lease_until:'preserved'});
      const [runs] = await connection.query<RowDataPacket[]>('SELECT * FROM workflow_runs');
      expect(runs.find(row => row.id === run)).toMatchObject({coordinator_address_id:address,coordinator_session_id:session,coordinator_binding_generation:7,coordinator_native_instance_id:instance,coordinator_ownership_mode:'connection',coordinator_lease_until:null});
      expect(runs.find(row => row.id === 'unmatched')).toMatchObject({coordinator_address_id:address,coordinator_session_id:null,coordinator_ownership_mode:'connection',coordinator_lease_until:null});
      expect(runs.find(row => row.id === 'completed')).toMatchObject({coordinator_ownership_mode:'timed',coordinator_lease_until:'preserved'});
      expect(runs.find(row => row.id === 'modern')).toMatchObject({coordinator_session_id:'preserved',coordinator_binding_generation:9,coordinator_native_instance_id:'preserved',coordinator_lease_until:'preserved'});
    } finally {
      for (const table of tables) await connection.query(`DROP TEMPORARY TABLE IF EXISTS ${table}`);
      connection.release();
    }
  });
});
