<script lang="ts">
  /**
   * Read-only preview of the artifact as it will be serialized.
   *
   * - For collections: pass `frontmatter` (key→value) + `body`; renders a
   *   YAML-ish frontmatter block followed by the markdown body.
   * - For settings: pass `json` (any value); renders pretty-printed JSON.
   */
  type Props = {
    frontmatter?: Record<string, unknown>;
    body?: string;
    json?: unknown;
    class?: string;
  };
  let { frontmatter, body = "", json, class: className = "" }: Props = $props();

  function isEmpty(value: unknown): boolean {
    if (value === undefined || value === null || value === "") return true;
    if (Array.isArray(value)) return value.length === 0;
    return false;
  }

  function serializeValue(value: unknown): string {
    if (Array.isArray(value)) {
      return value.filter((v) => v !== "" && v !== null && v !== undefined).join(", ");
    }
    return String(value);
  }

  function serializeFrontmatter(fm: Record<string, unknown>): string {
    const lines = Object.entries(fm)
      .filter(([, v]) => !isEmpty(v))
      .map(([k, v]) => `${k}: ${serializeValue(v)}`);
    return lines.join("\n");
  }

  /**
   * The `body` prop for collection artifacts is the server's canonical
   * `ArtifactView.body` — the whole stored file, frontmatter block included
   * (so hand-authored keys the form doesn't expose still round-trip). Strip
   * that leading block here so it isn't shown twice under the block we
   * render from `frontmatter` above.
   */
  function stripLeadingFrontmatter(text: string): string {
    if (!text.startsWith("---\n")) return text;
    const end = text.indexOf("\n---", 3);
    if (end === -1) return text;
    return text.slice(end + 4).replace(/^\n+/, "");
  }

  const rendered = $derived.by(() => {
    if (json !== undefined) {
      try {
        return JSON.stringify(json, null, 2);
      } catch {
        return String(json);
      }
    }
    const fm = frontmatter ? serializeFrontmatter(frontmatter) : "";
    if (!fm) return body ?? "";
    return `---\n${fm}\n---\n\n${stripLeadingFrontmatter(body ?? "")}`;
  });
</script>

<pre
  class={`max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed ${className}`}>{rendered}</pre>
