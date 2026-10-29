import { z } from 'zod';
export const roomListSchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  view: z.enum(['active', 'history', 'all']).default('active'),
});
export type RoomListView = z.infer<typeof roomListSchema>['view'];
export const roomSendSchema = z
  .object({
    room_id: z.string().uuid(),
    client_request_id: z.string().uuid(),
    content: z.string().trim().max(30000).default(''),
    attachments: z.array(z.string().uuid()).max(10).default([]),
    reply_to: z.string().uuid().optional(),
    recipients: z.array(z.string().uuid()).max(100).default([]),
    ask_all: z.boolean().default(false),
  })
  .strict()
  .refine((b) => !!b.content || b.attachments.length > 0, 'Write a message or attach a file')
  .refine((b) => !(b.ask_all && b.recipients.length), 'Choose individual recipients or the whole round');
export const roomCreateSchema = z
  .object({
    client_request_id: z.string().uuid(),
    kind: z.enum(['group', 'conference']),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1024).default(''),
    members: z.array(z.string().uuid()).max(100).default([]),
    duration_minutes: z.number().int().min(5).max(360).default(60),
  })
  .strict();
export const roomManageSchema = z
  .object({
    client_request_id: z.string().uuid(),
    room_id: z.string().uuid(),
    action: z.enum(['invite', 'remove', 'close']),
    address_id: z.string().uuid().optional(),
  })
  .strict()
  .refine((b) => b.action === 'close' || !!b.address_id, 'Choose a member');
export const roomReadSchema = z
  .object({
    room_id: z.string().uuid(),
    before: z.string().max(250).optional(),
    /** Delta cursor: agent_room_changes.seq from a previous read's `next_after`. */
    after: z
      .union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d{1,16}$/u).transform(Number)])
      .optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((b) => !(b.before && b.after !== undefined), 'Use either a history cursor or a delta cursor');
export type RoomKind = 'group' | 'conference' | 'project' | 'host';
export interface RoomMember {
  id: string;
  name: string;
  engine: string;
  session_id: string | null;
  binding_generation?: number;
  reachable: boolean;
  chat_capable: boolean;
  role: string;
  /** Newest room event time shown to this agent through chats/read; null if never read. */
  read_through?: string | null;
}
export interface Room {
  id: string;
  kind: RoomKind;
  title: string;
  description: string;
  status: string;
  created_at: string;
  members: RoomMember[];
  workflow_managed?: boolean;
  workflow_run_id?: string;
  workflow_report_url?: string;
  owner_admin_id?: number | null;
  deadline_at?: string;
  unread?: number;
  /** The operator's own read position (agent_room_reads.read_at); null if never read. */
  read_at?: string | null;
  last_activity_at?: string;
}
export interface RoomEvent {
  id: string;
  created_at: string;
  actor: string;
  name: string;
  content: string;
  attachments: string[];
  reply_to?: string;
  kind: string;
  deliveries?: { address_id: string; status: string }[];
  /** Operator reads only (0119): emoji in order of first use, `mine` for the reading operator. */
  reactions?: { emoji: string; count: number; mine: boolean }[];
}
