import type { OwnerStateDraft } from './store.js';

/** Mirror only SQL foreign-key side effects. The caller must schedule the parent DELETE. */
export function projectDaemonSessionDeletion(draft: OwnerStateDraft, sessionId: string): void {
  for (const row of draft.table('hostDaemonOperations').by('sessionId', sessionId))
    draft.removeRow('hostDaemonOperations', row);
  for (const row of draft.table('hostDaemonPortalBindings').by('daemonSessionId', sessionId))
    draft.removeRow('hostDaemonPortalBindings', row);
  for (const row of draft.table('companionDaemonFollows').by('daemonSessionId', sessionId))
    draft.removeRow('companionDaemonFollows', row);
}

export function projectHostDeletion(draft: OwnerStateDraft, hostId: number): void {
  for (const row of draft.table('hostDaemonSessions').by('hostId', hostId))
    projectDaemonSessionDeletion(draft, row.id);
  for (const table of [
    'hostDaemons',
    'hostDaemonSessions',
    'hostDaemonOperations',
    'sessionHousekeepingReservations',
    'advisorSessions',
    'engineDestroyHosts',
  ] as const) {
    for (const row of draft.table(table).by('hostId', hostId)) draft.removeRow(table, row);
  }
  for (const row of draft.table('hostSpawns').by('targetHostId', hostId)) draft.removeRow('hostSpawns', row);
  for (const table of ['secrets', 'coordProjectMemories', 'sharedMemories'] as const) {
    for (const row of draft.table(table).by('sourceHostId', hostId))
      draft.upsert(table, { ...row, sourceHostId: null });
  }
}

export function projectAdminUserDeletion(draft: OwnerStateDraft, userId: number): void {
  for (const table of ['chattySessions', 'chattyRuns', 'chattyActions'] as const) {
    for (const row of draft.table(table).by('userId', userId)) draft.removeRow(table, row);
  }
  // chatty_events and shared_memory_revisions are cold and have no owner projection.
}
