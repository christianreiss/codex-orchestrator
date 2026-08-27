/**
 * Project coordination ("CoCo") admin API.
 *
 * Thin functional wrappers around the typed `api.*` client; query and mutation
 * builders to be used with `@tanstack/svelte-query`.
 */
import { api } from "./client";
import type {
  ProjectAbout,
  ProjectAssistResponse,
  ProjectChangesResponse,
  ProjectDetailResponse,
  ProjectFeedback,
  ProjectFeedbackType,
  ProjectFile,
  ProjectListResponse,
  ProjectModuleState,
  ProjectNote,
  ProjectSummary,
  ProjectTodo,
  BoardResponse,
  BoardCard,
  BoardColumn,
  ProjectBoardModuleState,
} from "./types";

const BASE = "/admin/projects";

const encodeSlug = (slug: string): string => encodeURIComponent(slug);

// ─────────────────────────── Module state ──────────────────────────────

export const fetchProjectsState = (): Promise<ProjectModuleState> =>
  api.get<ProjectModuleState>(`${BASE}/state`);

export const updateProjectsState = (enabled: boolean): Promise<ProjectModuleState> =>
  api.post<ProjectModuleState>(`${BASE}/state`, { enabled });

// ─────────────────────────── List / Create / Delete ─────────────────────

export const fetchProjects = (): Promise<ProjectListResponse> =>
  api.get<ProjectListResponse>(BASE);

export interface CreateProjectPayload {
  slug: string;
  about?: ProjectAbout | null;
  roster_markdown?: string;
}

export const createProject = (payload: CreateProjectPayload): Promise<ProjectDetailResponse> =>
  api.post<ProjectDetailResponse>(BASE, payload);

export const deleteProject = (slug: string): Promise<{ deleted: string }> =>
  api.delete<{ deleted: string }>(`${BASE}/${encodeSlug(slug)}`);

// ─────────────────────────── Detail / Identity ──────────────────────────

export const fetchProject = (slug: string): Promise<ProjectDetailResponse> =>
  api.get<ProjectDetailResponse>(`${BASE}/${encodeSlug(slug)}`);

export const updateAbout = (
  slug: string,
  about: ProjectAbout,
): Promise<{ project: ProjectSummary; about: ProjectAbout | null }> =>
  api.post(`${BASE}/${encodeSlug(slug)}/about`, { about });

export const updateRoster = (
  slug: string,
  roster_markdown: string,
): Promise<{ project: ProjectSummary; roster_markdown: string }> =>
  api.post(`${BASE}/${encodeSlug(slug)}/roster`, { roster_markdown });

export const assistProject = (slug: string): Promise<ProjectAssistResponse> =>
  api.post<ProjectAssistResponse>(`${BASE}/${encodeSlug(slug)}/assist`, {});

// ─────────────────────────── Changes ────────────────────────────────────

export const fetchChanges = (slug: string, since = 0): Promise<ProjectChangesResponse> => {
  const qs = since > 0 ? `?since=${encodeURIComponent(String(since))}` : "";
  return api.get<ProjectChangesResponse>(`${BASE}/${encodeSlug(slug)}/changes${qs}`);
};

// ─────────────────────────── Notes ──────────────────────────────────────

export const fetchNotes = (slug: string): Promise<{ project: string; notes: ProjectNote[] }> =>
  api.get(`${BASE}/${encodeSlug(slug)}/notes`);

export interface NotePayload {
  header: string;
  body: string;
}

export const createNote = (slug: string, payload: NotePayload) =>
  api.post<{ project: string; note: ProjectNote }>(`${BASE}/${encodeSlug(slug)}/notes`, payload);

export const updateNote = (slug: string, id: number, payload: NotePayload) =>
  api.post<{ project: string; note: ProjectNote }>(
    `${BASE}/${encodeSlug(slug)}/notes/${id}`,
    payload,
  );

export const deleteNote = (slug: string, id: number) =>
  api.delete<{ project: string; deleted: number }>(`${BASE}/${encodeSlug(slug)}/notes/${id}`);

// ─────────────────────────── Todos ──────────────────────────────────────

export const fetchTodos = (slug: string): Promise<{ project: string; todos: ProjectTodo[] }> =>
  api.get(`${BASE}/${encodeSlug(slug)}/todos`);

export interface TodoPayload {
  title: string;
  detail?: string;
}

export const createTodo = (slug: string, payload: TodoPayload) =>
  api.post<{ project: string; todo: ProjectTodo }>(`${BASE}/${encodeSlug(slug)}/todos`, payload);

export const updateTodo = (slug: string, id: number, payload: TodoPayload) =>
  api.post<{ project: string; todo: ProjectTodo }>(
    `${BASE}/${encodeSlug(slug)}/todos/${id}`,
    payload,
  );

export const markTodoDone = (slug: string, id: number) =>
  api.post<{ project: string; todo: ProjectTodo }>(
    `${BASE}/${encodeSlug(slug)}/todos/${id}/done`,
  );

export const markTodoUndone = (slug: string, id: number) =>
  api.post<{ project: string; todo: ProjectTodo }>(
    `${BASE}/${encodeSlug(slug)}/todos/${id}/undone`,
  );

export const deleteTodo = (slug: string, id: number) =>
  api.delete<{ project: string; deleted: number }>(`${BASE}/${encodeSlug(slug)}/todos/${id}`);

// ─────────────────────────── Board ──────────────────────────────────────
//
// The module switch lives outside `/admin/projects/…` because that tree routes
// `/admin/projects/{slug}` and a project named `board` would shadow it.

export const fetchBoard = (slug: string): Promise<BoardResponse> =>
  api.get(`${BASE}/${encodeSlug(slug)}/board`);

export const fetchBoardState = (): Promise<ProjectBoardModuleState> =>
  api.get("/admin/project-board/state");

export const setBoardEnabled = (enabled: boolean): Promise<ProjectBoardModuleState> =>
  api.post("/admin/project-board/state", { enabled });

export interface CardPayload {
  title: string;
  detail?: string;
  column?: string;
  labels?: string[];
  priority?: number;
}

export const createCard = (slug: string, payload: CardPayload) =>
  api.post<{ project: string; card: BoardCard }>(`${BASE}/${encodeSlug(slug)}/board/cards`, payload);

export const updateCard = (slug: string, id: string, payload: Partial<CardPayload> & { blocked_reason?: string | null }) =>
  api.post<{ project: string; card: BoardCard }>(
    `${BASE}/${encodeSlug(slug)}/board/cards/${encodeURIComponent(id)}`,
    payload,
  );

export const moveCard = (slug: string, id: string, column: string, note?: string) =>
  api.post<{ project: string; card: BoardCard; advisories: { code: string; message: string }[] }>(
    `${BASE}/${encodeSlug(slug)}/board/cards/${encodeURIComponent(id)}/move`,
    note ? { column, note } : { column },
  );

/** Takes a claim back on the operator's behalf; it does not move the card. */
export const releaseCard = (slug: string, id: string, reason?: string) =>
  api.post<{ released: boolean; project: string; card: BoardCard }>(
    `${BASE}/${encodeSlug(slug)}/board/cards/${encodeURIComponent(id)}/release`,
    reason ? { reason } : {},
  );

export const deleteCard = (slug: string, id: string) =>
  api.delete<{ project: string; deleted: number }>(
    `${BASE}/${encodeSlug(slug)}/board/cards/${encodeURIComponent(id)}`,
  );

export interface ColumnPayload {
  title?: string;
  wip_limit?: number | null;
  allowed_roles?: string[] | null;
  position?: number;
  default_next_column_id?: string | null;
}

export const updateColumn = (slug: string, id: string, payload: ColumnPayload) =>
  api.post<{ project: string; column: BoardColumn }>(
    `${BASE}/${encodeSlug(slug)}/board/columns/${encodeURIComponent(id)}`,
    payload,
  );

// ─────────────────────────── Files ──────────────────────────────────────

export const fetchFiles = (slug: string): Promise<{ project: string; files: ProjectFile[] }> =>
  api.get(`${BASE}/${encodeSlug(slug)}/files`);

export interface FilePayload {
  stored_name: string;
  mime_type?: string | null;
  description?: string | null;
  content: string;
}

export const upsertFile = (slug: string, payload: FilePayload) =>
  api.post<{ project: string; file: ProjectFile }>(`${BASE}/${encodeSlug(slug)}/files`, payload);

export const deleteFile = (slug: string, id: number) =>
  api.delete<{ project: string; deleted: number }>(`${BASE}/${encodeSlug(slug)}/files/${id}`);

// ─────────────────────────── Feedback ───────────────────────────────────

export const fetchFeedback = (
  slug: string,
): Promise<{ project: string | null; feedback: ProjectFeedback[] }> =>
  api.get(`${BASE}/${encodeSlug(slug)}/feedback`);

export interface FeedbackPayload {
  type: ProjectFeedbackType;
  title: string;
  body: string;
}

export const createFeedback = (slug: string, payload: FeedbackPayload) =>
  api.post<{ project: string; feedback: ProjectFeedback }>(
    `${BASE}/${encodeSlug(slug)}/feedback`,
    payload,
  );

// ─────────────────────────── Query key factory ──────────────────────────

export const projectKeys = {
  state: ["projects", "state"] as const,
  list: ["projects"] as const,
  detail: (slug: string) => ["project", slug] as const,
  notes: (slug: string) => ["project", slug, "notes"] as const,
  todos: (slug: string) => ["project", slug, "todos"] as const,
  // Matches the key `projectDetailSubKey` builds for every project.card.* and
  // project.board.* websocket event; a mismatch here silently stops the board
  // updating when another agent moves a card.
  board: (slug: string) => ["project", slug, "board"] as const,
  boardState: ["projects", "board", "state"] as const,
  files: (slug: string) => ["project", slug, "files"] as const,
  feedback: (slug: string) => ["project", slug, "feedback"] as const,
  changes: (slug: string) => ["project", slug, "changes"] as const,
};
