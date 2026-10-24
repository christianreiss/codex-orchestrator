import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import * as schema from '../db/schema.js';
import { decrypt, encrypt } from '../security/secret-box.js';
import type { Keyring } from '../security/keyring.js';
import type { ControlPlaneOwnership } from './owner.js';
import {
  canonicalCommand,
  CommitUncertainError,
  type CommandPersistence,
  type CommandReceipt,
  type Json,
  type OutboxIntent,
} from './commands.js';

export type PersistenceTransaction = MySql2Database<typeof schema>;

/** All writes and receipts share the connection holding the owner lock. */
export class OwnerPersistence implements CommandPersistence<PersistenceTransaction> {
  private activeConnection: PoolConnection | undefined;
  constructor(
    private readonly owner: ControlPlaneOwnership,
    private readonly keyring: Keyring,
  ) {}

  async receipt(principal: string, id: string): Promise<CommandReceipt | undefined> {
    const [rows] = await this.owner
      .heldConnection()
      .execute<
        RowDataPacket[]
      >('SELECT kind, request_digest, owner_epoch, CAST(sequence AS CHAR) AS sequence, result_enc, replay_class, result_state FROM control_plane_command_receipts WHERE principal = ? AND request_id = ?', [principal, id]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      principal,
      id,
      kind: String(row.kind),
      digest: String(row.request_digest),
      revision: { epoch: String(row.owner_epoch), sequence: BigInt(row.sequence as string) },
      result: row.result_state === 'expired' ? null : JSON.parse(decrypt(String(row.result_enc), this.keyring)) as Json,
      replayClass: row.replay_class as CommandReceipt['replayClass'],
      resultState: row.result_state as CommandReceipt['resultState'],
    };
  }

  async transaction(run: (tx: PersistenceTransaction) => Promise<void>): Promise<void> {
    if (this.activeConnection) throw new Error('Nested/concurrent owner transaction');
    const connection = this.owner.heldConnection();
    this.activeConnection = connection;
    let committing = false;
    try {
      await connection.beginTransaction();
      await run(drizzle(connection, { schema, mode: 'default' }));
      this.owner.assertHeld();
      committing = true;
      await connection.commit();
    } catch (error) {
      if (committing) {
        const uncertain = new CommitUncertainError(error);
        this.owner.lose(uncertain);
        throw uncertain;
      }
      try {
        await connection.rollback();
      } catch (rollbackError) {
        this.owner.lose(rollbackError);
      }
      throw error;
    } finally {
      this.activeConnection = undefined;
    }
  }

  async record(
    _tx: PersistenceTransaction,
    receipt: CommandReceipt,
    outbox: readonly OutboxIntent[],
  ): Promise<void> {
    const connection = this.activeConnection;
    if (!connection) throw new Error('Receipt must be recorded inside its owner transaction');
    const now = new Date().toISOString();
    await connection.execute(
      'INSERT INTO control_plane_command_receipts (principal, request_id, kind, request_digest, owner_epoch, sequence, result_enc, created_at, replay_class, result_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        receipt.principal,
        receipt.id,
        receipt.kind,
        receipt.digest,
        receipt.revision.epoch,
        receipt.revision.sequence.toString(),
        encrypt(canonicalCommand(receipt.result), this.keyring),
        now,
        receipt.replayClass ?? 'external',
        'available',
      ],
    );
    for (const intent of outbox) {
      await connection.execute(
        'INSERT INTO control_plane_outbox (id, principal, request_id, kind, target, payload_enc, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          intent.id,
          receipt.principal,
          receipt.id,
          intent.kind,
          intent.target,
          encrypt(canonicalCommand(intent.payload), this.keyring),
          intent.availableAt,
          now,
        ],
      );
    }
    const [result] = await connection.execute<ResultSetHeader>(
      'UPDATE control_plane_owner SET sequence = ? WHERE id = 1 AND epoch = ? AND sequence = ?',
      [
        receipt.revision.sequence.toString(),
        receipt.revision.epoch,
        (receipt.revision.sequence - 1n).toString(),
      ],
    );
    if (result.affectedRows !== 1) {
      const error = new Error('Owner epoch/revision changed during mutation');
      this.owner.lose(error);
      throw error;
    }
  }
}
