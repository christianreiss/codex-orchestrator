import { wsPublisher } from '../../ws/publisher.js';

export type CompanionScope = 'me' | 'agents' | 'approvals' | 'hosts' | 'rooms';
export interface CompanionSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number): void;
  on(event: 'close' | 'error', listener: () => void): unknown;
}
export interface CompanionLiveSources {
  authorize(token: string | undefined): Promise<readonly string[] | { capabilities: readonly string[]; expiresAt: string }>;
  subscribe?(listener: () => void): () => void;
  revisions(): Promise<{ agents: string; approvals: string; hosts?: string }>;
}

interface Client {
  socket: CompanionSocket;
  token: string | undefined;
  capabilities: readonly string[];
  lastPing: number;
  expiry?: ReturnType<typeof setTimeout>;
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Companion live check timed out')), 10_000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Event-driven authorization and invalidations; periodic frames are transport-only. */
export class CompanionLive {
  private readonly clients = new Set<Client>();
  private readonly interval: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeState?: () => void;
  private scheduled?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private pending = new Set<CompanionScope>();
  private previous?: { agents: string; approvals: string; hosts?: string };
  private stopped = false;

  constructor(private readonly sources: CompanionLiveSources) {
    this.interval = setInterval(() => { for (const client of this.clients) this.send(client, { type: 'ping' }); }, 15_000);
    this.unsubscribeState = this.sources.subscribe?.(() => this.schedule('me', 'agents', 'approvals', 'hosts', 'rooms'));
    this.interval.unref();
    this.unsubscribe = wsPublisher.subscribe(({ type }) => {
      if (/^(host\.|engine\.)/.test(type)) this.schedule('agents', 'hosts', 'approvals');
      else if (/^agent_room_chat\./.test(type)) this.schedule('rooms');
      else if (/^(agent_portal\.|agent_messaging\.)/.test(type)) this.schedule('agents', 'rooms');
      else if (/^insecure\./.test(type)) this.schedule('approvals');
      else if (/^(companion\.|user\.|admin\.user\.|settings\.)/.test(type))
        this.schedule('me', 'agents', 'approvals', 'hosts', 'rooms');
    });
  }

  attach(socket: CompanionSocket, token: string | undefined): void {
    const client: Client = { socket, token, capabilities: [], lastPing: Date.now() };
    this.clients.add(client);
    const cleanup = () => { clearTimeout(client.expiry); this.clients.delete(client); };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    this.send(client, { type: 'hello', ...wsPublisher.cursor(), resync: true });
    this.schedule('me', 'agents', 'approvals', 'hosts', 'rooms');
  }

  private send(client: Client, frame: Record<string, unknown>): void {
    if (this.stopped || !this.clients.has(client)) return;
    try {
      if (client.socket.readyState !== 1 || client.socket.bufferedAmount > 64 * 1024) {
        this.close(client, 1013);
        return;
      }
      client.socket.send(JSON.stringify({ ...frame, ts: new Date().toISOString() }));
    } catch {
      this.close(client, 1013);
    }
  }

  private close(client: Client, code: number): void {
    this.clients.delete(client); clearTimeout(client.expiry);
    try {
      client.socket.close(code);
    } catch {
      /* disconnected */
    }
  }

  private schedule(...scopes: CompanionScope[]): void {
    if (this.stopped || !this.clients.size) return;
    for (const scope of scopes) this.pending.add(scope);
    if (this.running || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      this.running = this.flush().finally(() => {
        this.running = undefined;
        if (this.pending.size) this.schedule();
      });
    }, 50);
    this.scheduled.unref();
  }

  private async flush(): Promise<void> {
    const scopes = this.pending;
    this.pending = new Set();
    try {
      const checked = await Promise.all(
        [...this.clients].map(async (client) => {
          try {
            const authorization = await bounded(this.sources.authorize(client.token));
            const capabilities = 'capabilities' in authorization ? authorization.capabilities : authorization;
            if ('expiresAt' in authorization) {
              const remaining = Date.parse(authorization.expiresAt) - Date.now();
              if (!Number.isFinite(remaining) || remaining <= 0) { this.close(client, 4001); return null; }
              clearTimeout(client.expiry);
              client.expiry = setTimeout(() => remaining <= 2_147_483_647 ? this.close(client, 4001) : this.schedule('me'), Math.min(remaining, 2_147_483_647)); client.expiry.unref();
            }
            if (JSON.stringify(capabilities) !== JSON.stringify(client.capabilities)) scopes.add('me');
            client.capabilities = capabilities;
            return this.clients.has(client) ? client : null;
          } catch (error) {
            this.close(client, (error as { status?: number }).status === 401 ? 4001 : 1013);
            return null;
          }
        }),
      );
      const authorized = checked.filter((client): client is Client => client !== null);
      if (!authorized.length || this.stopped) return;
      const next = await bounded(this.sources.revisions());
      if (next.agents !== this.previous?.agents) scopes.add('agents');
      if (next.approvals !== this.previous?.approvals) scopes.add('approvals');
      if (next.hosts !== this.previous?.hosts) {
        scopes.add('hosts');
        // Remote conversation presence is projected from daemon health too.
        // A lost daemon can leave its durable session unchanged, so refresh
        // agent cards even when no Portal event or agent revision changed.
        scopes.add('agents');
      }
      this.previous = next;
      for (const client of authorized) {
        // The revision snapshot may await I/O in legacy fixtures. Recheck before delivery.
        try {
          const current = await bounded(this.sources.authorize(client.token));
          client.capabilities = 'capabilities' in current ? current.capabilities : current;
          if ('expiresAt' in current && Date.parse(current.expiresAt) <= Date.now()) { this.close(client, 4001); continue; }
        } catch (error) { this.close(client, (error as { status?: number }).status === 401 ? 4001 : 1013); continue; }
        const allowed = [...scopes].filter(
          (scope) =>
            scope === 'me' ||
            client.capabilities.includes(
              scope === 'rooms' ? 'agent_messaging.read' : scope === 'agents'
                ? 'agent_portal.read'
                : scope === 'hosts'
                  ? 'admin.read'
                  : 'hosts.activate_insecure',
            ),
        );
        if (allowed.length) this.send(client, { type: 'changed', scopes: allowed, ...wsPublisher.cursor() });

      }
    } catch {
      for (const client of this.clients) this.close(client, 1013);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.interval);
    clearTimeout(this.scheduled);
    this.pending.clear();
    this.unsubscribe(); this.unsubscribeState?.();
    for (const client of this.clients) this.close(client, 1001);
    await this.running;
  }
}
