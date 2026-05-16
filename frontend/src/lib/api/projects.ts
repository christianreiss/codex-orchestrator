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
  files: (slug: string) => ["project", slug, "files"] as const,
  feedback: (slug: string) => ["project", slug, "feedback"] as const,
  changes: (slug: string) => ["project", slug, "changes"] as const,
};
