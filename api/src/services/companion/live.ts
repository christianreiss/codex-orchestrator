import { wsPublisher } from '../../ws/publisher.js';

export type CompanionScope = 'me' | 'agents' | 'approvals';
export interface CompanionSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number): void;
  on(event: 'close' | 'error', listener: () => void): unknown;
}
export interface CompanionLiveSources {
  authorize(token: string | undefined): Promise<readonly string[]>;
  revisions(): Promise<{ agents: string; approvals: string }>;
}

interface Client {
  socket: CompanionSocket;
  token: string | undefined;
  capabilities: readonly string[];
  lastPing: number;
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

/** One shared reconciliation loop, metadata-only invalidations, and no per-phone data polling. */
export class CompanionLive {
  private readonly clients = new Set<Client>();
  private readonly interval: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private scheduled?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private pending = new Set<CompanionScope>();
  private previous?: { agents: string; approvals: string };
  private stopped = false;

  constructor(private readonly sources: CompanionLiveSources) {
    this.interval = setInterval(() => this.schedule(), 5000);
    this.interval.unref();
    this.unsubscribe = wsPublisher.subscribe(({ type }) => {
      if (/^(agent_portal\.|agent_messaging\.|host\.|engine\.)/.test(type)) this.schedule('agents');
      else if (/^insecure\./.test(type)) this.schedule('approvals');
      else if (/^(companion\.|user\.|admin\.user\.|settings\.)/.test(type))
        this.schedule('me', 'agents', 'approvals');
    });
  }

  attach(socket: CompanionSocket, token: string | undefined): void {
    const client: Client = { socket, token, capabilities: [], lastPing: Date.now() };
    this.clients.add(client);
    const cleanup = () => this.clients.delete(client);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    this.send(client, { type: 'hello' });
    this.schedule('me', 'agents', 'approvals');
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
    this.clients.delete(client);
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
            const capabilities = await bounded(this.sources.authorize(client.token));
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
      this.previous = next;
      for (const client of authorized) {
        const allowed = [...scopes].filter(
          (scope) =>
            scope === 'me' ||
            client.capabilities.includes(
              scope === 'agents' ? 'agent_portal.read' : 'hosts.activate_insecure',
            ),
        );
        if (allowed.length) this.send(client, { type: 'changed', scopes: allowed });
        if (Date.now() - client.lastPing >= 15_000) {
          client.lastPing = Date.now();
          this.send(client, { type: 'ping' });
        }
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
    this.unsubscribe();
    for (const client of this.clients) this.close(client, 1001);
    await this.running;
  }
}
