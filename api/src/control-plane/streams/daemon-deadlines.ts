import { createHash } from 'node:crypto';
import type { OwnerStateSnapshot } from '../state/store.js';
import type { OwnerWorkObligation } from '../../ops/owner-worker.js';
import { daemonAccepting } from '../../services/host-daemon/policy.js';

/** Exact deadlines consumed by DaemonOperations.sweep; no idle scan obligation. */
export function daemonSweepObligations(
  snapshot: OwnerStateSnapshot,
  now: number,
  retentionHours: number,
): OwnerWorkObligation[] {
  return snapshot.daemons.all().flatMap((config) => {
    const work = snapshot.table('hostDaemonSessions').by('hostId', config.hostId),
      operations = snapshot.table('hostDaemonOperations').by('hostId', config.hostId);
    const dates: number[] = [];
    const add = (n: number) => {
      if (Number.isFinite(n)) dates.push(n);
    };
    const terminal = ['completed', 'failed', 'unknown', 'stopped', 'canceled', 'expired'];
    if (
      config.settings.expires_at &&
      (operations.some((o) => ['queued', 'offered'].includes(o.status)) ||
        work.some((s) => ['queued', 'idle', 'waiting'].includes(s.status)))
    )
      add(Date.parse(config.settings.expires_at));
    for (const op of operations) {
      const session = work.find((s) => s.id === op.sessionId);
      if (!session) continue;
      if (['queued', 'offered'].includes(op.status) && session.status === 'queued')
        add(Date.parse(op.createdAt) + 600000);
      if (terminal.includes(op.status) && ['closed', 'failed', 'unknown'].includes(session.status))
        add(Date.parse(session.lastActivityAt) + retentionHours * 3600000 + 1);
    }
    const promptInputs: unknown[] = [];
    const peerInputs: unknown[] = [];
    for (const session of work) {
      const prompts = session.sessionId
        ? snapshot
            .table('agentPrompts')
            .by('sessionId', session.sessionId)
            .filter((p) => p.status === 'open')
        : [];
      if (['running', 'idle', 'waiting'].includes(session.status) && session.sessionId) {
        promptInputs.push(prompts.map((p) => [p.id, p.createdAt, p.version]));
        if (session.status !== 'running' && session.status !== (prompts.length ? 'waiting' : 'idle')) add(0);
        for (const prompt of prompts)
          add(Date.parse(prompt.createdAt) + config.settings.question_minutes * 60000);
      }
      if (!['idle', 'waiting'].includes(session.status)) continue;
      const pending = session.addressId
        ? snapshot.messages
            .by('targetAddressId', session.addressId)
            .filter((m) => ['queued', 'leased', 'accepted'].includes(m.status))
        : [];
      peerInputs.push(pending.map((m) => [m.id, m.status]));
      if (pending.length) continue;
      if (!daemonAccepting(config.settings)) add(0);
      else
        add(
          Date.parse(session.lastActivityAt) +
            (session.status === 'waiting' ? config.settings.question_minutes : config.settings.idle_minutes) *
              60000,
        );
    }
    if (!dates.length) return [];
    const revision = createHash('sha256')
      .update(JSON.stringify([config.settings, work, operations, promptInputs, peerInputs]))
      .digest('hex');
    // Immediate transitions use a stable dueAt, otherwise each rescan would
    // replace the obligation before its callback could run.
    return [{ key: String(config.hostId), dueAt: Math.min(...dates), revision }];
  });
}
