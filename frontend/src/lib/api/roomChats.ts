import { api } from "./client";
import type { UploadItem } from "$lib/portal/chat-files";
import type { ReactionSummary } from "$lib/portal/room-annotations";
export interface RoomMember {
  id: string;
  name: string;
  engine: string;
  session_id: string | null;
  reachable: boolean;
  chat_capable?: boolean;
  role: string;
}
export interface ChatRoom {
  id: string;
  kind: "group" | "conference" | "host" | "project";
  title: string;
  description: string;
  status: string;
  created_at: string;
  members: RoomMember[];
  workflow_run_id?: string;
  workflow_report_url?: string;
  workflow_managed?: boolean;
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
  kind: string;
  attachments: string[];
  reply_to?: string;
  deliveries?: { address_id: string; status: string }[];
  /** Canonical room events only; absent on older servers. */
  reactions?: ReactionSummary[];
}
export interface RoomHistory {
  room: ChatRoom;
  events: RoomEvent[];
  next_before: string | null;
  /** Pinned event ids, newest pin first; absent on older servers. */
  pinned?: string[];
}
export interface RoomSend {
  room_id: string;
  client_request_id: string;
  content: string;
  attachments: string[];
  reply_to?: string;
  recipients: string[];
  ask_all: boolean;
}
export interface RoomDraft {
  text: string;
  uploads: UploadItem[];
  recipients: string[];
  replyTo?: string;
  pending?: RoomSend;
  scrollTop?: number;
  manageRequest?: Record<string, unknown> | null;
}
export const emptyRoomDraft = (): RoomDraft => ({
  text: "",
  uploads: [],
  recipients: [],
});
export const roomKeys = ["agent-messaging", "chats"] as const;
export const roomRoot = "/admin/agent-messaging/chats";
export interface RoomPage {
  enabled: boolean;
  rooms: ChatRoom[];
  has_more: boolean;
  next_offset: number | null;
}
export const roomOptions = (enabled = true, view: 'active' | 'history' | 'all' = 'active') => ({
  queryKey: [...roomKeys, view],
  initialPageParam: 0,
  queryFn: ({
    signal,
    pageParam,
  }: {
    signal: AbortSignal;
    pageParam: number;
  }) => api.get<RoomPage>(`${roomRoot}?offset=${pageParam}&view=${view}`, { signal }),
  getNextPageParam: (last: RoomPage) => last.next_offset ?? undefined,
  enabled,

});
export const roomHistoryOptions = (id: string, enabled: boolean) => ({
  queryKey: [...roomKeys, id, "history"],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.post<RoomHistory>(`${roomRoot}/read`, { room_id: id }, { signal }),
  enabled,

});
export function matchingRooms(
  rooms: ChatRoom[],
  search: string,
  engine: string,
) {
  const q = search.trim().toLowerCase();
  return rooms.filter(
    (r) =>
      (!q ||
        `${r.title} ${r.description} ${r.members.map((m) => m.name).join(" ")}`
          .toLowerCase()
          .includes(q)) &&
      (engine === "all" || r.members.some((m) => m.engine === engine)),
  );
}
export const roomKindLabel = (kind: ChatRoom["kind"]) =>
  ({
    group: "Groups",
    conference: "Conferences",
    host: "Host rooms",
    project: "Project rooms",
  })[kind];
