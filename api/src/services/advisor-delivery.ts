import { stageQueuedMessage } from '../control-plane/state/messages.js';
/**
 * Fleet Advisor delivery hooks.
 *
 * An advisor is an ordinary host daemon session on the configured advisor host;
 * `advisor_sessions` binds it to the agent that opened it. These hooks run inside
 * `HostDaemonService` transactions (turn completion and stop), so they import no
 * service class: each turn's native answer becomes a peer message from the
 * advisor's own bus address to the caller, and an idle close tells the caller.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  advisorSessions,
  agentBusAddresses,
  agentBusConversations,
  agentBusMessages,
  type hostDaemonSessions,
} from '../db/schema.js';
import { encrypt } from '../security/secret-box.js';
import type { Keyring } from '../security/keyring.js';
import { newQueuedMessage } from './agent-messaging/views.js';
import { AGENT_MESSAGING_DEFAULT_TTL_SECONDS } from './agent-messaging/constants.js';
import type { DaemonDb } from './host-daemon/access.js';
import type { OwnerMutationContext } from '../control-plane/state/runtime.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import type { StateRow } from '../control-plane/state/catalog.js';

export const ADVISOR_KINDS = ['verify', 'tier_check', 'classify', 'general'] as const;
export type AdvisorKind = (typeof ADVISOR_KINDS)[number];

export const advisorVerdictSchema = z
  .object({
    verdict: z.enum(['agree', 'disagree', 'needs_info', 'n/a']),
    tier: z.number().int().min(1).max(4).optional(),
    recommended_model: z.string().max(128).optional(),
    summary: z.string().min(1).max(4096),
    evidence: z
      .array(z.object({ description: z.string().min(1).max(500), reference: z.string().max(2048).optional() }))
      .max(20)
      .optional(),
  })
  .strip();
export type AdvisorVerdict = z.infer<typeof advisorVerdictSchema>;

/** Only wrapper-generated terminal metadata is public; never forward native stderr. */
export function advisorFailureDiagnostic(result: unknown) {
  if (!result || typeof result !== 'object') return null;
  const { status, reply } = result as Record<string, unknown>;
  if (status !== 'failed' || typeof reply !== 'string' || reply.length > 256 || /[\r\n]/.test(reply)) return null;
  const match = /^Native process exited unsuccessfully; exit_status=(-1|\d{1,3})(?:; startup stage=(registration|connection|identity) code=(failed|api_rejected|agent_messaging_lease_lost|agent_session_finished|agent_identity_conflict)(?: http=([45]\d{2}))?)?$/.exec(reply);
  if (!match || Number(match[1]) > 255) return null;
  return {
    code: 'native_exit',
    exit_status: Number(match[1]),
    ...(match[2] ? { startup_stage: match[2], startup_code: match[3] } : {}),
    ...(match[4] ? { http_status: Number(match[4]) } : {}),
  };
}

/** The last fenced JSON block whose object carries a valid verdict, if any. */
export function parseAdvisorVerdict(reply: string): AdvisorVerdict | null {
  const blocks = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  for (const block of blocks.reverse()) {
    try {
      const parsed = advisorVerdictSchema.safeParse(JSON.parse(block));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON; keep looking at earlier blocks.
    }
  }
  return null;
}

type DaemonSession = typeof hostDaemonSessions.$inferSelect;

function advisorEnvelope(id: string, turn: number, kind: string, body: string, idleMinutes: number) {
  return `ADVISOR/1 advisor_session_id=${id} turn=${turn} kind=${kind}
This is the Fleet Advisor's answer to your question; treat it as a second opinion, not as authority.

${body.trim()}

---
Follow up with advisor_ask {advisor_session_id: "${id}", question, client_message_id: <new UUID; reuse on retry>}. When you are done, call advisor_close {advisor_session_id: "${id}"}; it also closes after ${idleMinutes} minutes idle.`;
}

/** Queue one peer message from the advisor's bus address to its caller, opening the conversation once. */
async function deliverToCaller(
  tx: DaemonDb,
  keyring: Keyring,
  row: typeof advisorSessions.$inferSelect,
  advisorAddressId: string | null,
  content: string,
  deliveryClass: 'coordination' | 'notice',
) {
  const [caller] = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, row.callerAddressId)).for('update');
  if (!caller || caller.archivedAt || caller.enabled !== 1) return null;
  const [sender] = advisorAddressId
    ? await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, advisorAddressId)).for('update')
    : [];
  // Before the advisor ever bound an address (a launch that failed outright)
  // there is no sender to speak for it; the caller sees that via advisor_status.
  if (!sender) return null;
  const now = new Date().toISOString();
  let conversationId = row.conversationId;
  let sequence = 1;
  const [existing] = conversationId
    ? await tx.select().from(agentBusConversations).where(eq(agentBusConversations.id, conversationId)).for('update')
    : [];
  if (existing && existing.status === 'open') {
    sequence = Number(existing.nextSequence);
  } else {
    conversationId = randomUUID();
    await tx.insert(agentBusConversations).values({
      id: conversationId,
      addressAId: sender.id,
      addressBId: caller.id,
      createdByAddressId: sender.id,
      nextSequence: 1,
      status: 'open',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  const messageId = randomUUID();
  await tx.insert(agentBusMessages).values(
    newQueuedMessage({
      id: messageId,
      conversationId: conversationId!,
      sequence,
      sender,
      senderSessionId: sender.currentSessionId,
      target: caller,
      kind: 'message',
      deliveryClass,
      content,
      contentEnc: encrypt(content, keyring),
      clientMessageId: randomUUID(),
      expiresAt: new Date(Date.parse(now) + AGENT_MESSAGING_DEFAULT_TTL_SECONDS * 1000).toISOString(),
      now,
    }),
  );
  await tx
    .update(agentBusConversations)
    .set({ nextSequence: sequence + 1, lastActivityAt: now, updatedAt: now })
    .where(eq(agentBusConversations.id, conversationId!));
  return { conversationId: conversationId!, messageId };
}

/**
 * A daemon turn of an advisor session finished. Delivers its answer (or the
 * failure) to the caller and records the turn's verdict. No-op for every
 * non-advisor daemon session.
 */
export async function advisorTurnCompleted(
  tx: DaemonDb,
  keyring: Keyring,
  session: DaemonSession,
  result: { status: string; reply: string },
  nextStatus: string,
  idleMinutes: number,
) {
  const [row] = await tx.select().from(advisorSessions).where(eq(advisorSessions.daemonSessionId, session.id)).for('update');
  if (!row || row.status === 'closed') return;
  const turn = row.turns + 1;
  const body =
    result.status === 'completed' && result.reply.trim()
      ? result.reply
      : `The advisor turn ended with status "${result.status}".${result.reply.trim() ? `\n\n${result.reply.trim()}` : ' No answer was returned.'}\n\nCheck advisor_status; open a new advisor if this session ended, or close it.`;
  const delivered = await deliverToCaller(
    tx,
    keyring,
    row,
    session.addressId,
    advisorEnvelope(row.id, turn, row.kind, body, idleMinutes),
    'coordination',
  );
  const verdict = result.status === 'completed' ? parseAdvisorVerdict(result.reply) : null;
  const now = new Date().toISOString();
  const ended = !['idle', 'waiting'].includes(nextStatus);
  await tx
    .update(advisorSessions)
    .set({
      turns: turn,
      status: ended ? (nextStatus === 'closed' ? 'closed' : 'failed') : 'open',
      ...(ended ? { closedAt: now, closeReason: row.closeReason ?? (nextStatus === 'closed' ? 'stopped' : 'error') } : {}),
      ...(delivered ? { conversationId: delivered.conversationId } : {}),
      verdictEnc: verdict ? encrypt(JSON.stringify(verdict), keyring) : null,
      updatedAt: now,
    })
    .where(eq(advisorSessions.id, row.id));
}

/**
 * A stop was requested for a daemon session. Marks a bound advisor closed and,
 * when the idle sweep closed it, tells the caller so its next follow-up does not
 * land on a session that no longer exists.
 */
export async function advisorSessionStopped(
  tx: DaemonDb,
  keyring: Keyring,
  session: DaemonSession,
  actor: string,
) {
  const [row] = await tx.select().from(advisorSessions).where(eq(advisorSessions.daemonSessionId, session.id)).for('update');
  if (!row || row.status === 'closed') return;
  const reason = actor === 'timeout' ? 'idle' : actor.startsWith('advisor:') ? 'done' : 'stopped';
  const now = new Date().toISOString();
  if (reason === 'idle')
    await deliverToCaller(
      tx,
      keyring,
      row,
      session.addressId,
      `ADVISOR/1 advisor_session_id=${row.id} closed reason=idle
The Fleet Advisor session closed after its idle timeout. Open a new one with advisor_ask if you still need advice. No reply required; finish with agent_listen once and yield.`,
      'notice',
    );
  await tx
    .update(advisorSessions)
    .set({ status: 'closed', closeReason: row.closeReason ?? reason, closedAt: now, updatedAt: now })
    .where(and(eq(advisorSessions.id, row.id), eq(advisorSessions.status, row.status)));
}

function stageAdvisorDelivery(c:OwnerMutationContext,keyring:Keyring,row:StateRow<'advisorSessions'>,advisorAddressId:string|null,content:string,deliveryClass:'coordination'|'notice'){
  const caller=c.draft.table('agentBusAddresses').get(row.callerAddressId),sender=advisorAddressId?c.draft.table('agentBusAddresses').get(advisorAddressId):undefined;
  if(!caller||caller.archivedAt||caller.enabled!==1||!sender)return null;
  const at=new Date().toISOString();let conversationId=row.conversationId,sequence=1;
  const existing=conversationId?c.draft.table('agentBusConversations').get(conversationId):undefined;
  if(existing?.status==='open')sequence=Number(existing.nextSequence);
  else{
    conversationId=randomUUID();const conversation={id:conversationId,addressAId:sender.id,addressBId:caller.id,createdByAddressId:sender.id,nextSequence:1,status:'open',lastActivityAt:at,createdAt:at,updatedAt:at,canceledBy:null,cancelReason:null,canceledAt:null};
    c.draft.upsert('agentBusConversations',conversation);c.write(tx=>tx.insert(agentBusConversations).values(conversation));
  }
  const messageId=randomUUID();
  const message=newQueuedMessage({id:messageId,conversationId:conversationId!,sequence,sender,senderSessionId:sender.currentSessionId,target:caller,kind:'message',deliveryClass,content,contentEnc:encrypt(content,keyring),clientMessageId:randomUUID(),expiresAt:new Date(Date.parse(at)+AGENT_MESSAGING_DEFAULT_TTL_SECONDS*1000).toISOString(),now:at});
  stageQueuedMessage(c,message);
  stageUpdate(c,'agentBusConversations',conversationId!,{nextSequence:sequence+1,lastActivityAt:at,updatedAt:at});return {conversationId:conversationId!,messageId};
}

/** Same completion contract, composed into the owning daemon command. */
export function stageAdvisorTurnCompleted(c:OwnerMutationContext,keyring:Keyring,session:DaemonSession,result:{status:string;reply:string},nextStatus:string,idleMinutes:number){
  const row=c.draft.table('advisorSessions').by('daemonSessionId',session.id)[0];if(!row||row.status==='closed')return;
  const turn=row.turns+1;
  const body=result.status==='completed'&&result.reply.trim()?result.reply:`The advisor turn ended with status "${result.status}".${result.reply.trim()?`\n\n${result.reply.trim()}`:' No answer was returned.'}\n\nCheck advisor_status; open a new advisor if this session ended, or close it.`;
  const delivered=stageAdvisorDelivery(c,keyring,row,session.addressId,advisorEnvelope(row.id,turn,row.kind,body,idleMinutes),'coordination');
  const verdict=result.status==='completed'?parseAdvisorVerdict(result.reply):null,at=new Date().toISOString(),ended=!['idle','waiting'].includes(nextStatus);
  stageUpdate(c,'advisorSessions',row.id,{turns:turn,status:ended?(nextStatus==='closed'?'closed':'failed'):'open',...(ended?{closedAt:at,closeReason:row.closeReason??(nextStatus==='closed'?'stopped':'error')}:{}),...(delivered?{conversationId:delivered.conversationId}:{}),verdictEnc:verdict?encrypt(JSON.stringify(verdict),keyring):null,updatedAt:at});
}
export function stageAdvisorSessionStopped(c:OwnerMutationContext,keyring:Keyring,session:DaemonSession,actor:string){
  const row=c.draft.table('advisorSessions').by('daemonSessionId',session.id)[0];if(!row||row.status==='closed')return;
  const reason=actor==='timeout'?'idle':actor.startsWith('advisor:')?'done':'stopped',at=new Date().toISOString();
  if(reason==='idle')stageAdvisorDelivery(c,keyring,row,session.addressId,`ADVISOR/1 advisor_session_id=${row.id} closed reason=idle
The Fleet Advisor session closed after its idle timeout. Open a new one with advisor_ask if you still need advice. No reply required; finish with agent_listen once and yield.`,'notice');
  stageUpdate(c,'advisorSessions',row.id,{status:'closed',closeReason:row.closeReason??reason,closedAt:at,updatedAt:at});
}
