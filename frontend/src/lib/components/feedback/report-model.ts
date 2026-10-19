/** Wording and presentation shared by the global Reports inbox and a project's Reports tab. */
import type { BadgeVariant } from "$lib/components/ui/badge";
import type { FeedbackItem } from "$lib/api/feedback";

/** One row of an inbox, whatever kind of report it is. */
export type ReportRow = {
  id: string;
  title: string;
  badges: Array<{ label: string; variant?: BadgeVariant }>;
  /** Static secondary text, e.g. the component. Never markup. */
  meta?: string;
  /** Creation time; the inbox renders it as relative time with the exact timestamp on hover. */
  created?: string | null;
  /** A second muted line, e.g. who holds the claim. */
  note?: string;
};

/** Native select / input styling for the report forms (keeps `selectOption` testable). */
export const controlClass =
  "flex h-9 w-full rounded-md border border-input bg-card px-3 py-2 text-body-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25";
/** Toolbar filter controls: sized by the caller (`w-44`), never full width. */
export const filterClass =
  "h-9 rounded-md border border-input bg-card px-3 text-body-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25";
export const areaClass =
  "flex min-h-20 w-full rounded-md border border-input bg-card px-3 py-2 text-body-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25";

export const humanize = (value: string): string => value.replaceAll("_", " ");

export function actorLabel(actor: Record<string, unknown> | null): string {
  if (!actor) return "Unassigned";
  if (actor.kind === "system") return "System";
  if (actor.admin_user_id != null) return `Admin ${actor.admin_user_id}`;
  return `${actor.engine ?? "Agent"} · Host ${actor.host_id ?? "?"}${actor.agent_uuid ? ` · ${actor.agent_uuid}` : ""}`;
}

/** One inbox row for an orchestrator report (age counts from creation, not the last update). */
export function feedbackRow(r: FeedbackItem): ReportRow {
  return {
    id: r.id,
    title: r.title,
    badges: [
      { label: r.priority, variant: r.priority === "critical" ? "destructive" : r.priority === "high" ? "warning" : "outline" },
      { label: r.type },
      { label: humanize(r.status), variant: r.status === "resolved" ? "success" : "secondary" },
    ],
    meta: r.component,
    created: r.created_at,
    note: r.claim_owner ? actorLabel(r.claim_owner) : undefined,
  };
}
