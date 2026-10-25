/**
 * Shared types for Agent Messaging.
 *
 * Part of the `agent-messaging` module; the public interface is the
 * `AgentMessagingService` facade in `../agent-messaging.ts`.
 */

import type { Host } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import type { Engine } from '../../util/engine.js';
import type { WorkspaceInput } from './workspace.js';

export type MessagingHost = Omit<Host, 'apiKey' | 'apiKeyEnc'> & { authFingerprint?: string };

export type AgentMessagingDb = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

export type AgentMessagingOutcome = 'accepted' | 'completed' | 'retry' | 'dead' | 'ambiguous';

export interface RegisterMessagingSessionInput {
  rebootRequestId?: string;
  rebootBootId?: string;
  engine: Engine;
  username: string;
  cwd: string;
  workspace?: WorkspaceInput;
  upstreamSessionId?: string | null;
  invocationKind: 'interactive' | 'execute' | 'peer_delivery';
  resumed?: boolean;
  sessionId: string;
  bridgeToken: string;
  requestedAddress?: string | null;
  expectedBindingGeneration?: number | null;
  continuity?: 'native' | 'reset';
  deliveryMessageId?: string;
  deliveryClaimId?: string;
  adapterProtocol?: string | null;
  adapterCapabilities?: Record<string, unknown> | null;
}

export interface MessageDelivery {
  execution_contract_version: number;
  work_kind: string | null;
  task_result_status: string | null;
  execution_version: number;
  message_id: string;
  conversation_id: string;
  sequence: number;
  reply_to_message_id: string | null;
  kind: string;
  delivery_class?: string;
  delivery_timing?: string;
  coalesce_key?: string | null;
  related_work_id?: string | null;
  event_count?: number;
  event_first_at?: string | null;
  event_last_at?: string | null;
  digest_id?: string | null;
  superseded_by_id?: string | null;
  presented_at?: string | null;
  content: string;
  content_bytes: number;
  sender: Record<string, unknown>;
  target: Record<string, unknown>;
  attempts: number;
  claim_id: string;
  lease_owner: string;
  lease_until: string | null;
  ownership_mode?: string;
  expires_at: string;
}
