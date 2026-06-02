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

  const rendered = $derived.by(() => {
    if (json !== undefined) {
      try {
        return JSON.stringify(json, null, 2);
      } catch {
        return String(json);
      }
    }
    const fm = frontmatter ? serializeFrontmatter(frontmatter) : "";
    const head = fm ? `---\n${fm}\n---\n\n` : "";
    return `${head}${body ?? ""}`;
  });
</script>

<pre
  class={`max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed ${className}`}>{rendered}</pre>
