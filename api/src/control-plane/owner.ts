import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { OwnerUnavailableError } from './commands.js';

export type OwnerPhase = 'new' | 'acquiring' | 'hydrating' | 'ready' | 'lost' | 'closed';

/**
 * Single process ownership. This connection also carries every durable command.
 * Deployment remains stop-before-start: this is not an automatic failover lease.
 */
export class ControlPlaneOwnership {
  readonly epoch = randomUUID();
  private connection: PoolConnection | undefined;
  private phase: OwnerPhase = 'new';
  private listeners = new Set<(reason: unknown) => void>();
  private readonly lockName: string;
  constructor(
    private readonly pool: Pool,
    database: string,
  ) {
    this.lockName = 'orchestrator.owner.' + createHash('sha256').update(database).digest('hex').slice(0, 40);
  }
  status(): OwnerPhase {
    return this.phase;
  }
  assertReady(): void {
    if (this.phase !== 'ready') throw new OwnerUnavailableError(`Control-plane owner ${this.phase}`);
  }
  assertHeld(): void {
    if (this.phase !== 'ready' && this.phase !== 'hydrating')
      throw new OwnerUnavailableError(`Control-plane owner ${this.phase}`);
  }
  heldConnection(): PoolConnection {
    this.assertHeld();
    return this.connection!;
  }
  onLost(listener: (reason: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async acquire(): Promise<PoolConnection> {
    if (this.phase !== 'new') throw new OwnerUnavailableError('Ownership instances cannot be reused');
    this.phase = 'acquiring';
    try {
      const connection = await this.pool.getConnection();
      this.connection = connection;
      connection.on('error', this.connectionLost);
      connection.on('end', this.connectionLost);
      // A genuinely quiet owner must not need SQL keepalive polls to retain
      // its advisory lock. Connection loss still fences the owner immediately.
      await connection.query('SET SESSION wait_timeout = 31536000');
      const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [
        this.lockName,
      ]);
      if (this.phase !== 'acquiring' || Number(rows[0]?.acquired) !== 1)
        throw new OwnerUnavailableError('Another control-plane owner holds the database');
      this.phase = 'hydrating';
      return connection;
    } catch (error) {
      this.lose(error);
      throw error;
    }
  }
  /** Call after migrations. Epoch change and snapshot hydration use one transaction. */
  async hydrate<T>(load: (connection: PoolConnection, epoch: string) => Promise<T>): Promise<T> {
    if (this.phase !== 'hydrating') throw new OwnerUnavailableError('Owner is not hydrating');
    const connection = this.heldConnection();
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.beginTransaction();
      await connection.execute(
        'INSERT INTO control_plane_owner (id, epoch, sequence, started_at) VALUES (1, ?, 0, ?) ON DUPLICATE KEY UPDATE epoch = VALUES(epoch), sequence = 0, started_at = VALUES(started_at)',
        [this.epoch, new Date().toISOString()],
      );
      const snapshot = await load(connection, this.epoch);
      this.assertHeld();
      await connection.commit();
      this.assertHeld();
      return snapshot;
    } catch (error) {
      this.lose(error);
      throw error;
    }
  }
  ready(): void {
    if (this.phase !== 'hydrating') throw new OwnerUnavailableError('Owner cannot become ready');
    this.phase = 'ready';
  }
  lose(reason: unknown): void {
    if (this.phase === 'lost' || this.phase === 'closed') return;
    this.phase = 'lost';
    // Destroy, never release to a pool that could reconnect and retain old RAM.
    this.connection?.destroy();
    for (const listener of this.listeners) {
      try {
        listener(reason);
      } catch {
        /* loss remains final */
      }
    }
  }
  async close(): Promise<void> {
    if (this.phase === 'closed') return;
    const previous = this.phase;
    this.phase = 'closed';
    for (const listener of this.listeners) {
      try {
        listener(new OwnerUnavailableError('Owner stopped'));
      } catch {
        /* readiness already withdrawn */
      }
    }
    this.listeners.clear();
    if (this.connection && previous !== 'lost') {
      try {
        // Wait for the server's unlock ACK before a stop-before-start replacement.
        await this.connection.query({ sql: 'SELECT RELEASE_LOCK(?) AS released', timeout: 5000 }, [
          this.lockName,
        ]);
      } finally {
        this.connection.destroy();
      }
    }
  }
  private connectionLost = (error?: unknown): void => {
    this.lose(error ?? new Error('Owner connection ended'));
  };
}
