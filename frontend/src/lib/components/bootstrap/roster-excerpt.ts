/** Trims a project's roster markdown into a short, plain-text preview. */
export function excerptRoster(
  markdown: string | null | undefined,
  maxLines = 3,
  maxChars = 220,
): string {
  if (!markdown) return "";
  const lines = markdown
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, maxLines);
  const joined = lines.join("\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars).trimEnd()}…` : joined;
}
