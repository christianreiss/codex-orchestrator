/**
 * Coercion helpers for Claude artifact frontmatter, which the API types as
 * `Record<string, unknown>`. Keep these tolerant so a malformed value never
 * crashes an editor.
 */
import { CLAUDE_MODELS } from "$lib/constants/models";

export function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => asString(v)).filter((v) => v !== "");
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
  }
  return [];
}

/** Human-readable label for a model id; falls back to the raw value. */
export function modelLabel(value: string): string {
  const match = CLAUDE_MODELS.find((m) => m.value === value);
  if (match) return match.label;
  return value || "Inherit";
}
