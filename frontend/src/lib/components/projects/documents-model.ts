/** One list for a project's notes and files, with a kind filter and search. */
import type { ProjectFile, ProjectNote } from "$lib/api/types";

export type DocKind = "note" | "file";
export type KindFilter = "all" | "notes" | "files";

export const KIND_OPTIONS: Array<{ value: KindFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "notes", label: "Notes" },
  { value: "files", label: "Files" },
];

export type DocRow =
  | { key: string; kind: "note"; id: number; name: string; summary: string; updatedAt: string | null; note: ProjectNote }
  | { key: string; kind: "file"; id: number; name: string; summary: string; updatedAt: string | null; file: ProjectFile };

export const parseKind = (value: string | null): KindFilter => (value === "notes" || value === "files" ? value : "all");

const oneLine = (text: string, max = 100): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export function documentRows(notes: ProjectNote[], files: ProjectFile[], kind: KindFilter, query: string): DocRow[] {
  const rows: DocRow[] = [];
  if (kind !== "files") {
    for (const note of notes) {
      rows.push({ key: `note:${note.id}`, kind: "note", id: note.id, name: note.header, summary: oneLine(note.body), updatedAt: note.updated_at ?? note.created_at ?? null, note });
    }
  }
  if (kind !== "notes") {
    for (const file of files) {
      rows.push({ key: `file:${file.id}`, kind: "file", id: file.id, name: file.stored_name, summary: file.description ?? file.mime_type ?? "", updatedAt: file.updated_at ?? file.created_at ?? null, file });
    }
  }
  const needle = query.trim().toLowerCase();
  const matched = needle ? rows.filter((r) => `${r.name} ${r.summary}`.toLowerCase().includes(needle)) : rows;
  return matched.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
