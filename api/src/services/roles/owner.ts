import { AsyncLocalStorage } from 'node:async_hooks';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentRoleVersions, type AgentRoleVersion } from '../../db/schema.js';
import type { Json } from '../../control-plane/commands.js';
import {
  ownerRuntimeFor,
  mutateOwnerState,
  type OwnerMutationContext,
} from '../../control-plane/state/runtime.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import { ownedBridge, ownedAddress } from '../../control-plane/state/messaging.js';
import { parseRoleManifest, rolesDisabledError } from './contract.js';
import type { RoleDb } from './content.js';
import { ConflictError } from '../../http/errors.js';
interface RoleCommandContext {
  db: RoleDb;
  command: OwnerMutationContext;
  versions: Map<string, AgentRoleVersion>;
  blobs: Map<string, { content: string; encoding: string; size_bytes: number }>;
  events: Map<string, number>;
  nextFileId: number;
  notifications: Array<() => void>;
}
const commands = new AsyncLocalStorage<RoleCommandContext>();
export function roleContext() {
  return commands.getStore();
}
export function roleState(db: RoleDb): OwnerStateSnapshot | undefined {
  const ctx = roleContext();
  if (ctx) return ctx.command.draft.view();
  const owner = ownerRuntimeFor(db);
  owner?.assertOwner();
  return owner?.state.snapshot();
}
export function roleAgentProof(snapshot: OwnerStateSnapshot, sessionId: string, token: string) {
  if (snapshot.setting('roles_enabled') !== '1') throw rolesDisabledError();
  const identity = ownedBridge(snapshot, sessionId, token),
    session = identity.session;
  if (!session.agentBusAddressId)
    throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
  const address = ownedAddress(snapshot, session.agentBusAddressId);
  if (address.currentSessionId !== session.id || address.bindingGeneration !== session.bindingGeneration)
    throw new ConflictError('Agent binding changed', 'agent_binding_changed');
  return { ...identity, addressId: address.id, engine: session.engine, hostId: identity.host.id };
}
export async function roleCommand<T>(
  db: Database,
  kind: string,
  action: (db: RoleDb) => Promise<T>,
  authorize?: (snapshot: OwnerStateSnapshot) => void,
): Promise<T> {
  const runtime = ownerRuntimeFor(db);
  if (!runtime) return db.transaction(action);
  const inherited = roleContext();
  if (inherited) {
    authorize?.(inherited.command.draft.view());
    return action(db);
  }
  let result!: T;
  const notifications: Array<() => void> = [];
  const committed = await mutateOwnerState(runtime, {
    kind,
    payload: {},
    authorize,
    prepare: (command) =>
      commands.run(
        {
          db,
          command,
          versions: new Map(),
          blobs: new Map(),
          events: new Map(),
          nextFileId: -1,
          notifications,
        },
        async () => {
          result = await action(db);
          return () => JSON.parse(JSON.stringify(result ?? null)) as Json;
        },
      ),
  });
  for (const publish of notifications) publish();
  return result === undefined ? (committed as T) : result;
}
export function rolePublish(publish: () => void) {
  const ctx = roleContext();
  if (ctx) ctx.notifications.push(publish);
  else publish();
}
export async function roleVersion(db: RoleDb, id: string): Promise<AgentRoleVersion | undefined> {
  const ctx = roleContext(),
    staged = ctx?.versions.get(id);
  if (staged) return staged;
  const state = roleState(db),
    metadata = state?.table('agentRoleVersions').get(id);
  if (state && !metadata) return undefined;
  const [row] = await db.select().from(agentRoleVersions).where(eq(agentRoleVersions.id, id)).limit(1);
  return row && metadata ? { ...row, ...metadata } : row;
}
export function stageRoleVersion(ctx: RoleCommandContext, row: AgentRoleVersion) {
  ctx.versions.set(row.id, row);
  const role = ctx.command.draft.table('agentRoles').get(row.roleId);
  let roleLabel: string | null = null;
  try {
    roleLabel = role ? parseRoleManifest(role.slug, row.manifest).label : null;
  } catch {
    roleLabel = null;
  }
  ctx.command.draft.upsert('agentRoleVersions', { ...row, roleLabel });
}
