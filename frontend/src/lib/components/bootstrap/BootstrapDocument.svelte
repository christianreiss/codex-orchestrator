<script lang="ts">
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import Info from "@lucide/svelte/icons/info";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { ReadonlyCodeBlock } from "$lib/components/ui/code-block";
  import { engineLabel } from "$lib/api/keys";
  import type { ApiKeyEngine, ProjectDetailProject } from "$lib/api/types";
  import { excerptRoster } from "./roster-excerpt";

  type Props = {
    engine: ApiKeyEngine;
    issuedTo: string;
    /** Real plaintext -- only ever set right after creation or a fresh handoff. */
    keyValue: string | null;
    /** Set instead of `keyValue` when the doc composes from an existing, already-issued key. */
    keyPrefix: string | null;
    project: ProjectDetailProject | null;
  };
  let { engine, issuedTo, keyValue, keyPrefix, project }: Props = $props();

  // Mirrors the proxy-endpoint derivation on /api-keys.
  const origin = $derived(typeof window === "undefined" ? "" : window.location.origin);
  const path = $derived(engine === "openai" ? "/v1" : "/anthropic/v1");
  const url = $derived(`${origin}${path}`);
  const baseUrl = $derived(url || path);

  const baseUrlVar = $derived(engine === "openai" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL");
  const keyVar = $derived(engine === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");

  const keyLine = $derived(
    keyValue
      ? `${keyVar}=${keyValue}`
      : `${keyVar}=paste-your-key-here  # must start with ${keyPrefix ?? "the key's prefix"}`,
  );

  const envBlock = $derived(
    [`# Issued to: ${issuedTo || "(unnamed)"}`, `${baseUrlVar}=${baseUrl}`, keyLine].join("\n"),
  );

  const projectAbout = $derived(project?.about ?? null);
  const projectTitle = $derived(
    projectAbout?.title || projectAbout?.name || project?.slug || "",
  );
  const projectBlock = $derived(
    project
      ? [
          `# ${projectTitle} (${project.slug})`,
          projectAbout?.description || "No description yet.",
          "",
          `Open todos: ${project.counts.open_todos} · Notes: ${project.counts.notes} · Files: ${project.counts.files}`,
          "",
          "Roster:",
          excerptRoster(project.roster_markdown) || "(none yet)",
        ].join("\n")
      : "",
  );
</script>

<div class="flex flex-col gap-4">
  {#if keyValue}
    <Alert variant="warning">
      <AlertTriangle class="h-4 w-4" />
      <AlertTitle>Save this key somewhere safe</AlertTitle>
      <AlertDescription>
        We don't store the plaintext key. This is the only time it will be shown — copy it into
        place now.
      </AlertDescription>
    </Alert>
  {:else}
    <Alert variant="info">
      <Info class="h-4 w-4" />
      <AlertTitle>Plaintext isn't available for this key</AlertTitle>
      <AlertDescription>
        Existing keys never expose their value again after creation. Paste the value you saved
        when this key was issued in place of the placeholder below.
      </AlertDescription>
    </Alert>
  {/if}

  <ReadonlyCodeBlock label={`${engineLabel(engine)} environment`} value={envBlock} rows={3} />

  {#if project}
    <ReadonlyCodeBlock label="Project context" value={projectBlock} rows={5} wrap />
  {/if}
</div>
