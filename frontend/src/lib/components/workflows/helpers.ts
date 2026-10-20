import type { WorkflowDocument } from "../../api/workflows";
export const statusLabel = (value: string | null | undefined) => value ? value.replaceAll("_", " ").replace(/^./, c => c.toUpperCase()) : "Not recorded";
export function safeWorkflowUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^\/admin(?:\/|\?|$)/.test(value)) return value;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export const displayValue = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "Not recorded";
export const newWorkflowDocument = (): WorkflowDocument => ({ schema_version: 1, title: "", summary: "", goal: { statement: "", success_criteria: [{ id: "criterion-1", text: "" }] }, inputs: [], tasks: [{ id: "task-1", title: "", instructions: "", acceptance_criteria: [""], depends_on: [], knowledge_ids: [] }], knowledge: [] });
export function moveTask(document: WorkflowDocument, index: number, delta: number): WorkflowDocument {
  const tasks = [...document.tasks], other = index + delta;
  if (other < 0 || other >= tasks.length) return document;
  [tasks[index], tasks[other]] = [tasks[other], tasks[index]];
  return { ...document, tasks };
}
export function validateDraft(document: WorkflowDocument): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!document.title.trim()) errors.title = "Enter a workflow title.";
  if (!document.goal.statement.trim()) errors.goal = "Describe the one goal this workflow achieves.";
  if (!document.goal.success_criteria.length || document.goal.success_criteria.some(c => !c.text.trim())) errors.criteria = "Describe at least one verifiable success criterion.";
  if (!document.tasks.length) errors.tasks = "Add at least one task.";
  const ids = new Set(document.tasks.map(t => t.id));
  if (ids.size !== document.tasks.length) errors.tasks = "Task IDs must be unique.";
  const visiting = new Set<string>(), visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dep of document.tasks.find(t => t.id === id)?.depends_on ?? []) if (!ids.has(dep) || !walk(dep)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  if (document.tasks.some(t => !walk(t.id))) errors.tasks = "Dependencies must refer to existing tasks and cannot form a cycle.";
  for (const task of document.tasks) if (!task.title.trim() || !task.instructions.trim() || (!task.acceptance_criteria.length || task.acceptance_criteria.some(c => !c.trim()))) errors[`task-${task.id}`] = "Enter a title, instructions and at least one acceptance criterion.";
  const keys = new Set<string>();
  document.inputs.forEach((input, i) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.key) || keys.has(input.key)) errors[`input-key-${i}`] = "Input keys must be unique identifiers (up to 64 letters, digits, underscores or hyphens).";
    keys.add(input.key);
    if (!input.label.trim()) errors[`input-label-${i}`] = "Enter a label for this input.";
    if (input.type === "enum" && (!input.options?.length || input.options.some(o => !o.trim()))) errors[`input-options-${i}`] = "Enter one nonempty choice per line.";
    if (input.default !== undefined && (input.type === "enum" ? !input.options?.includes(String(input.default)) : typeof input.default !== input.type)) errors[`input-default-${i}`] = "The default must match the input type and its choices.";
  });
  const knowledgeIds = new Set<string>();
  document.knowledge.forEach((source, i) => {
    if (knowledgeIds.has(source.id)) errors[`source-title-${i}`] = "Knowledge IDs must be unique.";
    knowledgeIds.add(source.id);
    if (!source.title.trim()) errors[`source-title-${i}`] = "Enter a knowledge source title.";
    if (source.reference && (!/^(shared:\/\/[^\s]+|project:\/\/[^\s]+\/(memory|files)\/[^\s]+|skill:\/\/[^\s]+|https?:\/\/[^\s]+)$/.test(source.reference.uri) || /[\u0000-\u0020]/.test(source.reference.uri))) errors[`source-uri-${i}`] = "Use shared://, project:// with memory/files, skill://, https:// or http://. Host-local memory references are unavailable to other agents.";
  });
  return errors;
}
