import type {
  GitCloneRow,
  GitLeaseRow,
  GitRequestRow,
  GitStaleWorktreeRow,
  GitVerdict,
  GitWorktreeRow,
} from "$lib/api/gitDirector";

export type GitView = "merges" | "worktrees" | "history" | "settings";
export const GIT_VIEWS: readonly GitView[] = ["merges", "worktrees", "history", "settings"];

/** Old `?tab=` links used these names. */
const LEGACY_VIEW: Record<string, GitView> = { activity: "worktrees", merges: "merges", history: "history" };

export function parseGitView(view: string | null, legacyTab: string | null): GitView {
  if (view && (GIT_VIEWS as readonly string[]).includes(view)) return view as GitView;
  if (legacyTab && LEGACY_VIEW[legacyTab]) return LEGACY_VIEW[legacyTab];
  return "merges";
}

export type GitSelectionKind = "worktree" | "lease" | "recent" | "stale";
export type GitSelection = { cloneId: string; kind: GitSelectionKind; id: string };

export type GitRow =
  | { kind: "lease"; id: string; clone: GitCloneRow; lease: GitLeaseRow }
  | { kind: "worktree"; id: string; clone: GitCloneRow; worktree: GitWorktreeRow }
  | { kind: "recent"; id: string; clone: GitCloneRow; request: GitRequestRow }
  | { kind: "stale"; id: string; clone: GitCloneRow; stale: GitStaleWorktreeRow };

export function repoName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function verdictVariant(verdict: GitVerdict | string): "success" | "warning" | "destructive" | "secondary" {
  return verdict === "allow" ? "success" : verdict === "wait" ? "warning" : verdict === "deny" ? "destructive" : "secondary";
}

export function staleLabel(status: GitStaleWorktreeRow["status"]): string {
  return status === "superseded" ? "Reassigned" : status === "abandoned" ? "Session ended" : "Went quiet";
}

const matcher = (query: string) => (...values: (string | null | undefined)[]) => values.join(" ").toLowerCase().includes(query.trim().toLowerCase());

/** Flatten the clone registry into the rows of one view, applying the search box. */
export function buildGitRows(clones: GitCloneRow[], view: GitView, query: string): GitRow[] {
  const matches = matcher(query);
  const rows: GitRow[] = [];
  for (const clone of clones) {
    const base = [clone.repo_root, clone.remote_url, clone.fqdn] as const;
    const wt = (id: string) => clone.worktrees.find((w) => w.worktree_id === id);
    if (view === "worktrees") {
      for (const w of clone.worktrees) {
        if (matches(...base, w.username, w.task, w.branch, w.target_branch, w.worktree_path)) rows.push({ kind: "worktree", id: w.worktree_id, clone, worktree: w });
      }
    } else if (view === "merges") {
      for (const l of clone.leases) {
        const w = wt(l.worktree_id);
        if (matches(...base, l.target_branch, l.reason, w?.username, w?.task, w?.branch, w?.worktree_path)) rows.push({ kind: "lease", id: l.request_id, clone, lease: l });
      }
    } else if (view === "history") {
      for (const r of clone.recent) {
        const w = wt(r.worktree_id);
        if (matches(...base, r.target_branch, r.reason, w?.username, w?.task, w?.branch, w?.worktree_path)) rows.push({ kind: "recent", id: r.request_id, clone, request: r });
      }
      for (const s of clone.stale) {
        if (matches(...base, s.username, s.task, s.branch, s.worktree_path)) rows.push({ kind: "stale", id: s.worktree_id, clone, stale: s });
      }
    }
  }
  return rows;
}

/** Sheet title and subtitle for a selection (the record may have vanished since it was clicked). */
export function selectionTitle(clone: GitCloneRow | undefined, selection: GitSelection | null): { title: string; subtitle: string } {
  const kind = selection?.kind;
  const found = !clone || !selection
    ? false
    : kind === "worktree"
      ? clone.worktrees.some((w) => w.worktree_id === selection.id)
      : kind === "stale"
        ? clone.stale.some((w) => w.worktree_id === selection.id)
        : clone.leases.some((l) => l.request_id === selection.id) || clone.recent.some((l) => l.request_id === selection.id);
  const title = !found ? "Details unavailable" : kind === "worktree" ? "Worktree details" : kind === "stale" ? "Released registration" : "Merge decision";
  const subtitle = clone ? `${repoName(clone.repo_root)} · ${clone.fqdn ?? clone.host_id}` : "This record may have expired or been released.";
  return { title, subtitle };
}
