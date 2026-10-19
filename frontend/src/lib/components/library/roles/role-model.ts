/** Display vocabulary for agent roles; the API values stay as they are. */
import type { RolePolicy, RoleProposal } from "$lib/api/roles";

export function mutationLabel(mode: RolePolicy["mutation"]): string {
  return mode === "autonomous" ? "Self-improving" : mode === "supervised" ? "Supervised" : "Frozen";
}

export const PROPOSAL_STATUS: Record<RoleProposal["status"], { label: string; variant: "success" | "destructive" | "secondary" | "warning" }> = {
  checking: { label: "Being checked", variant: "secondary" },
  in_review: { label: "Waiting for a holder's review", variant: "secondary" },
  held: { label: "Held for you", variant: "warning" },
  applied: { label: "Published", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
  withdrawn: { label: "Withdrawn", variant: "secondary" },
  superseded: { label: "Superseded", variant: "secondary" },
};

export const RISK_LABEL: Record<RoleProposal["risk"], string> = {
  additive: "New material",
  modifying: "Changes material",
  core: "Changes the role prompt or core",
  revert: "Revert",
};

/** The starting point for a new role: frontmatter the parser accepts and an empty prompt to fill. */
export function starterManifest(slug: string, summary: string): string {
  return `---\nname: ${slug}\nsummary: ${JSON.stringify(summary)}\n---\n\n<Role prompt: responsibilities, boundaries, working method and quality bar.>\n`;
}

/** Exact timestamp with timezone, for titles and history rows (DESIGN.md INT-6). */
export function exactTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  // dateStyle/timeStyle cannot be combined with timeZoneName, so spell the fields out.
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

export function actorLabel(value: Record<string, unknown> | null | undefined): string {
  if (!value) return "—";
  if (value.kind === "admin") return "operator";
  if (value.kind === "server") return "self-improvement";
  return `agent ${String(value.address_id ?? "").slice(0, 8)}`;
}
