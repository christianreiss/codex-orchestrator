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
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type RoomKind = 'group' | 'conference' | 'project' | 'host';
export interface RoomMember {
  id: string;
  name: string;
  engine: string;
  session_id: string | null;
  reachable: boolean;
  chat_capable: boolean;
  role: string;
}
export interface Room {
  id: string;
  kind: RoomKind;
  title: string;
  description: string;
  status: string;
  created_at: string;
  members: RoomMember[];
  owner_admin_id?: number | null;
  deadline_at?: string;
  unread?: number;
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
}
