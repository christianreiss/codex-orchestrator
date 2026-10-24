import { randomUUID } from 'node:crypto';
import type { OwnerRuntime } from './state/runtime.js';
import { canonicalCommand, type Json } from './commands.js';
import type { StateScope } from './protocol.js';

export interface AttachmentIdentity {
  readonly connectionId: string;
  readonly hostId: number;
  readonly username: string;
  readonly scope: StateScope;
}
export interface LiveAttachment extends AttachmentIdentity {
  readonly id: string;
  readonly attachedAt: string;
}
export interface PresenceChange {
  readonly attachment: LiveAttachment;
  readonly connected: boolean;
}

/** Proven transport attachments only. No hydrated timestamp can populate this store. */
export class ConnectionPresence {
  private readonly attachments = new Map<string, LiveAttachment>();
  private readonly metadata = new Map<string, Json>();
  private readonly sessions = new Map<string, Set<string>>();
  private readonly connections = new Map<string, Set<string>>();
  private readonly roles = new Map<string, Set<string>>();
  private readonly listeners = new Set<(change: PresenceChange) => void>();
  private closed = false;
  constructor(private readonly error: (error: unknown) => void) {}

  attach(identity: AttachmentIdentity): { attachment: LiveAttachment; detach(): void } {
    if (this.closed) throw new Error('Owner presence closed');
    const attachment = Object.freeze({
      ...identity,
      scope: Object.freeze({ ...identity.scope }),
      id: randomUUID(),
      attachedAt: new Date().toISOString(),
    });
    this.attachments.set(attachment.id, attachment);
    this.add(this.connections, attachment.connectionId, attachment.id);
    this.add(this.roles, this.role(attachment.scope), attachment.id);
    if (attachment.scope.session_id) this.add(this.sessions, attachment.scope.session_id, attachment.id);
    this.emit({ attachment, connected: true });
    return { attachment, detach: () => this.detach(attachment) };
  }
  session(sessionId: string, generation: number, topic?: StateScope['topic']): readonly LiveAttachment[] {
    return [...(this.sessions.get(sessionId) ?? [])].flatMap((id) => {
      const value = this.attachments.get(id);
      return value && value.scope.binding_generation === generation && (!topic || value.scope.topic === topic)
        ? [value]
        : [];
    });
  }
  hasSession(sessionId: string, generation: number): boolean {
    return this.session(sessionId, generation, 'session').length > 0;
  }
  hasReceiver(sessionId: string, generation: number, receiverGeneration: string): boolean {
    return this.session(sessionId, generation, 'receiver').some(
      (value) => value.scope.receiver_generation === receiverGeneration,
    );
  }
  hasRelay(relayId: string): boolean {
    return (this.roles.get('relay:' + relayId)?.size ?? 0) > 0;
  }
  hasProvider(providerSessionId: string): boolean {
    return (this.roles.get('provider:' + providerSessionId)?.size ?? 0) > 0;
  }
  all(): readonly LiveAttachment[] {
    return [...this.attachments.values()];
  }
  hasDaemon(hostId: number, instanceId: string): boolean {
    return this.all().some(
      (a) => a.hostId === hostId && a.scope.topic === 'daemon' && a.scope.native_instance_id === instanceId,
    );
  }
  details(id: string): Json | undefined {
    const value = this.metadata.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }
  update(id: string, value: Json): void {
    const attachment = this.attachments.get(id);
    if (!attachment) throw new Error('Attachment ended');
    if (canonicalCommand(this.metadata.get(id) ?? null) === canonicalCommand(value)) return;
    this.metadata.set(id, structuredClone(value));
    this.emit({ attachment, connected: true });
  }
  forConnection(connectionId: string): readonly LiveAttachment[] {
    return [...(this.connections.get(connectionId) ?? [])].flatMap((id) => {
      const value = this.attachments.get(id);
      return value ? [value] : [];
    });
  }
  disconnect(connectionId: string): void {
    for (const attachment of this.forConnection(connectionId)) this.detach(attachment);
  }
  subscribe(listener: (change: PresenceChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.closed = true;
    for (const attachment of this.attachments.values()) this.detach(attachment);
    this.listeners.clear();
  }
  size(): number {
    return this.attachments.size;
  }
  private add(index: Map<string, Set<string>>, key: string, id: string): void {
    const entries = index.get(key) ?? new Set<string>();
    entries.add(id);
    index.set(key, entries);
  }
  private remove(index: Map<string, Set<string>>, key: string, id: string): void {
    const entries = index.get(key);
    entries?.delete(id);
    if (!entries?.size) index.delete(key);
  }
  private detach(attachment: LiveAttachment): void {
    if (this.attachments.get(attachment.id) !== attachment) return;
    this.attachments.delete(attachment.id);
    this.metadata.delete(attachment.id);
    this.remove(this.connections, attachment.connectionId, attachment.id);
    this.remove(this.roles, this.role(attachment.scope), attachment.id);
    if (attachment.scope.session_id) this.remove(this.sessions, attachment.scope.session_id, attachment.id);
    this.emit({ attachment, connected: false });
  }
  private emit(change: PresenceChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.error(error);
      }
    }
  }
  private role(scope: StateScope): string {
    return scope.topic + ':' + (scope.session_id ?? scope.relay_id ?? scope.provider_session_id ?? '');
  }
}

const ownerBindings = new WeakMap<OwnerRuntime, ConnectionPresence>();
export function bindOwnerPresence(runtime: OwnerRuntime, presence: ConnectionPresence): void {
  const prior = ownerBindings.get(runtime);
  if (prior && prior !== presence) throw new Error('Owner presence already bound');
  ownerBindings.set(runtime, presence);
}
export function ownerPresence(runtime: OwnerRuntime): ConnectionPresence {
  runtime.assertOwner();
  const presence = ownerBindings.get(runtime);
  if (!presence) throw new Error('Owner presence is not bound');
  return presence;
}
