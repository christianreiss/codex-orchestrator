/**
 * Coercion helpers for Claude artifact frontmatter, which the API types as
 * `Record<string, unknown>`. Keep these tolerant so a malformed value never
 * crashes an editor.
 */

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
