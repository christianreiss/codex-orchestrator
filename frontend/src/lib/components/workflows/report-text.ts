import type { WorkflowRun } from "$lib/api/workflows";
import { factLabel, statusLabel } from "./helpers";

/** Plain text for a handoff; diagnostics remain in the linked report. */
function valueText(value: unknown, indent = ""): string {
  if (Array.isArray(value)) return value.length ? value.map(item => `${indent}- ${valueText(item, `${indent}  `).trimStart()}`).join("\n") : "None recorded";
  if (value !== null && typeof value === "object") return Object.entries(value).map(([key, item]) => `${indent}${factLabel(key)}:${item !== null && typeof item === "object" ? "\n" : " "}${valueText(item, `${indent}  `)}`).join("\n");
  return value == null || value === "" ? "Not recorded" : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
}

export function reportText(run: WorkflowRun, issues: unknown[] = run.open_items ?? []): string {
  const facts = run.results ?? run.report?.results ?? {};
  const evaluation = run.evaluation?.draft ?? run.evaluation;
  const checks = run.criteria?.map(check => `${statusLabel(check.status)}: ${run.document?.goal.success_criteria.find(c => c.id === check.id)?.text ?? check.id}${check.reason ? `\n${check.reason}` : ""}`).join("\n\n");
  return [run.title, `Run: ${statusLabel(run.status)} · Outcome: ${statusLabel(run.outcome)}`, `Updated: ${run.updated_at}`, "Result", run.summary || "No result summary recorded.",
    ...(issues.length ? ["Open work", valueText(issues)] : []), ...(checks ? ["Acceptance checks", checks] : []),
    ...(Object.keys(facts).length ? ["Handover", valueText(facts)] : []),
    ...(evaluation ? ["Evaluation", `Status: ${statusLabel(run.evaluation?.status)}${evaluation.decision ? ` · ${statusLabel(String(evaluation.decision))}` : ""}`, typeof evaluation.reason === "string" ? evaluation.reason : "", ...(run.evaluation?.applied_version ? [`Published workflow version: ${run.evaluation.applied_version}`] : [])] : []),
    `Full report and evidence: ${run.report_url}`].filter(Boolean).join("\n\n");
}
