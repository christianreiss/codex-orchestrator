<script lang="ts">
  /**
   * The draft's support files. Existing files travel by blob reference; new
   * ones carry their body. Core files ship with every activation (text only,
   * within the activation budget); everything else is read on demand.
   */
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Upload from "@lucide/svelte/icons/upload";
  import type { DraftFileInput } from "$lib/api/roles";
  import { Button } from "$lib/components/ui/button";
  import { FormField } from "$lib/components/ui/form-field";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Table from "$lib/components/ui/table";

  export type EditableFile = DraftFileInput & { size_bytes?: number };

  let { files = $bindable() }: { files: EditableFile[] } = $props();

  let path = $state("");
  let content = $state("");
  let load = $state<"core" | "on_demand">("on_demand");
  let error = $state<string | null>(null);
  let upload: HTMLInputElement | undefined = $state();

  const selectClass = "h-8 rounded-sm border border-input bg-background px-2 text-body-sm";
  const size = (file: EditableFile) => file.size_bytes ?? (file.content !== undefined ? new TextEncoder().encode(file.content).length : 0);
  const human = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`);

  function validPath(value: string): string | null {
    if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part.startsWith("."))) return "Use a relative path such as refs/forms.md, without dot segments.";
    if (value === "ROLE.md") return "ROLE.md is the manifest above, not a support file.";
    if (files.some((file) => file.path === value)) return "A file with this path is already in the draft.";
    return null;
  }

  function addText() {
    const value = path.trim();
    error = validPath(value) ?? (content.trim() ? null : "Add the file's text.");
    if (error) return;
    files = [...files, { path: value, content, encoding: "utf8" as const, load }].sort((a, b) => a.path.localeCompare(b.path));
    path = content = "";
    load = "on_demand";
  }

  async function addUpload(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    const target = `refs/${file.name}`;
    error = validPath(target);
    if (!error && file.size > 4 * 1024 * 1024) error = "A role file can be at most 4 MiB.";
    if (error) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    files = [...files, { path: target, content: btoa(binary), encoding: "base64" as const, mime_type: file.type || undefined, load: "on_demand" as const, size_bytes: file.size }].sort((a, b) => a.path.localeCompare(b.path));
    if (upload) upload.value = "";
  }
</script>

<div class="space-y-3">
  {#if files.length}
    <div class="rounded-md border">
      <Table.Root regionLabel="Support files">
        <Table.Header>
          <Table.Row>
            <Table.Head>File</Table.Head>
            <Table.Head>Loaded</Table.Head>
            <Table.Head class="text-right">Size</Table.Head>
            <Table.Head class="w-10"><span class="sr-only">Remove</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each files as file, index (file.path)}
            <Table.Row>
              <Table.Cell class="min-w-48 space-y-1">
                <div class="break-all font-mono text-body-sm">{file.path}</div>
                <Input aria-label={`Description of ${file.path}`} placeholder="Description" class="h-8" value={file.description ?? ""} oninput={(event) => (files[index]!.description = (event.currentTarget as HTMLInputElement).value || null)} />
              </Table.Cell>
              <Table.Cell>
                <select class={selectClass} aria-label={`When ${file.path} is loaded`} bind:value={files[index]!.load} disabled={file.encoding === "base64"}>
                  <option value="on_demand">On demand</option>
                  <option value="core">With every activation</option>
                </select>
              </Table.Cell>
              <Table.Cell class="text-right tabular-nums text-body-sm">{human(size(file))}</Table.Cell>
              <Table.Cell>
                <Button variant="ghost" size="icon" aria-label={`Remove ${file.path}`} onclick={() => (files = files.filter((entry) => entry.path !== file.path))}>
                  <Trash2 class="h-4 w-4" />
                </Button>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {:else}
    <p class="text-body-sm text-muted-foreground">No support files. References, checklists and snippets go here; agents load them on demand.</p>
  {/if}

  <details class="rounded-md border">
    <summary class="cursor-pointer select-none px-3 py-2 text-body font-medium">Add a file</summary>
    <div class="space-y-3 border-t p-3">
      <FormField id="role-file-path" label="Path" hint="Relative, e.g. checklists/review.md." error={error ?? undefined}>
        <Input id="role-file-path" bind:value={path} class="font-mono" autocomplete="off" aria-describedby="role-file-path-hint" />
      </FormField>
      <FormField id="role-file-content" label="Text">
        <Textarea id="role-file-content" rows={6} class="font-mono" bind:value={content} />
      </FormField>
      <FormField id="role-file-load" label="Loaded">
        <select id="role-file-load" class={selectClass} bind:value={load}>
          <option value="on_demand">On demand</option>
          <option value="core">With every activation</option>
        </select>
      </FormField>
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" onclick={addText}><Plus class="h-4 w-4" />Add text file</Button>
        <Button variant="outline" onclick={() => upload?.click()}><Upload class="h-4 w-4" />Upload a file</Button>
        <input bind:this={upload} type="file" class="sr-only" tabindex="-1" aria-label="Upload a support file" onchange={addUpload} />
      </div>
      <p class="text-body-sm text-muted-foreground">Uploads land under refs/ and are always loaded on demand. Changes take effect when you save the draft.</p>
    </div>
  </details>
</div>
