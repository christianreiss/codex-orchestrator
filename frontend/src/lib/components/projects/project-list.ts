/** Search, archive scoping and sorting for the Projects list. */
import type { ProjectSummary } from "$lib/api/types";

export type ProjectSort = "updated" | "title" | "activity";

export const PROJECT_SORTS: Array<{ value: ProjectSort; label: string }> = [
  { value: "updated", label: "Recently updated" },
  { value: "activity", label: "Most active" },
  { value: "title", label: "Name" },
];

export function visibleProjects(
  projects: ProjectSummary[],
  opts: { query: string; showArchived: boolean; sort: ProjectSort },
): ProjectSummary[] {
  const query = opts.query.trim().toLowerCase();
  const scoped = opts.showArchived ? projects : projects.filter((p) => !p.archived_at);
  const rows = query
    ? scoped.filter((p) => [p.title, p.slug, p.description].some((v) => v?.toLowerCase().includes(query)))
    : scoped;
  return [...rows].sort((a, b) => {
    if (opts.sort === "title") return (a.title || a.slug).localeCompare(b.title || b.slug);
    if (opts.sort === "activity") return (b.latest_seq ?? 0) - (a.latest_seq ?? 0);
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  });
}
