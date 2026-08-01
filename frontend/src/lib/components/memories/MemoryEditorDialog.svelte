<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import Copy from "@lucide/svelte/icons/copy";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { ApiError } from "$lib/api/client";
  import {
    memoriesApi,
    memoriesKeys,
    type MemoryCreatePayload,
    type MemoryRecord,
    type MemoryScope,
    type MemoryUpdatePayload,
  } from "$lib/api/memories";
  import { fetchProjects, projectKeys } from "$lib/api/projects";
  import { hostsListQuery } from "$lib/api/hosts";
  import { copyTextToClipboard } from "$lib/utils/clipboard";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import { Textarea } from "$lib/components/ui/textarea";
  import KeyValueList, { type KeyValueRow } from "$lib/components/authoring/KeyValueList.svelte";

  type Props = {
    open: boolean;
    mode: "create" | "edit";
    memory?: MemoryRecord | null;
    onOpenChange: (open: boolean) => void;
    onSaved?: (memory: MemoryRecord) => void;
  };

  let { open = $bindable(), mode, memory = null, onOpenChange, onSaved }: Props = $props();

  const qc = useQueryClient();
  const hostsQuery = hostsListQuery();
  const projectsQuery = createQuery({ queryKey: projectKeys.list, queryFn: fetchProjects });

  const NONE = "none";
  let scope = $state<MemoryScope>("shared");
  let memoryId = $state("");
  let hostId = $state("");
  let projectSlug = $state("");
  let title = $state("");
  let summary = $state("");
  let content = $state("");
  let tagsInput = $state("");
  // Metadata is genuinely Record<string, unknown> server-side — nested
  // objects/arrays are real, observed data, not a hypothetical. A record
  // with only scalar values gets the typed KeyValueList editor; a record
  // with any nested/null value keeps the JSON textarea so nothing already
  // stored gets silently flattened or dropped. Decided once when the
  // dialog opens (in hydrate()/reset()), never flips while editing.
  let metadataMode = $state<"keyvalue" | "json">("keyvalue");
  let metadataInput = $state("{}");
  let metadataRows = $state<KeyValueRow[]>([]);
  let metadataTypes: Record<string, "string" | "number" | "boolean"> = {};
  let engine = $state(NONE);
  let validationError = $state<string | null>(null);
  let conflict = $state<{ message: string; currentEtag: string | null } | null>(null);
  let expectedEtag = $state("");
  let wasOpen = false;
  let reloading = $state(false);

  const hosts = $derived($hostsQuery.data?.hosts ?? []);
  const projects = $derived($projectsQuery.data?.projects ?? []);

  function setOpen(next: boolean): void {
    open = next;
    onOpenChange(next);
  }

  function reset(): void {
    scope = "shared";
    memoryId = "";
    hostId = "";
    projectSlug = "";
    title = "";
    summary = "";
    content = "";
    tagsInput = "";
    metadataMode = "keyvalue";
    metadataInput = "{}";
    metadataRows = [];
    metadataTypes = {};
    engine = NONE;
    validationError = null;
    conflict = null;
    expectedEtag = "";
  }

  function isScalar(v: unknown): v is string | number | boolean {
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  }

  function hydrate(record: MemoryRecord): void {
    scope = record.scope;
    memoryId = record.id;
    hostId = record.host_id == null ? "" : String(record.host_id);
    projectSlug = record.project_slug ?? "";
    title = record.title ?? "";
    summary = record.summary ?? "";
    content = record.content ?? "";
    tagsInput = (record.tags ?? []).join(", ");
    engine = record.engine ?? NONE;
    expectedEtag = record.etag;
    validationError = null;
    conflict = null;

    const metadata = record.metadata ?? {};
    const entries = Object.entries(metadata);
    // null is deliberately NOT scalar here: KeyValueList has no way to
    // represent "explicitly null" distinct from an empty string, so a
    // record containing one falls back to the JSON editor rather than
    // silently coercing null to "".
    if (entries.every(([, v]) => isScalar(v))) {
      metadataMode = "keyvalue";
      metadataTypes = {};
      metadataRows = entries.map(([key, value]) => {
        metadataTypes[key] = typeof value as "string" | "number" | "boolean";
        return { key, value: String(value) };
      });
      metadataInput = JSON.stringify(metadata, null, 2);
    } else {
      metadataMode = "json";
      metadataInput = JSON.stringify(metadata, null, 2);
      metadataRows = [];
      metadataTypes = {};
    }
  }

  /** Reconstructs typed values from KeyValueList's string rows, preserving
   *  each key's original type where the edited text still parses as that
   *  type; falls back to string for new keys or type-changing edits. */
  function metadataFromRows(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const { key, value } of metadataRows) {
      const trimmedKey = key.trim();
      if (!trimmedKey) continue;
      const originalType = metadataTypes[trimmedKey];
      if (originalType === "number" && value.trim() !== "" && Number.isFinite(Number(value))) {
        out[trimmedKey] = Number(value);
      } else if (originalType === "boolean" && (value === "true" || value === "false")) {
        out[trimmedKey] = value === "true";
      } else {
        out[trimmedKey] = value;
      }
    }
    return out;
  }

  $effect(() => {
    if (open && !wasOpen) {
      if (mode === "edit" && memory) hydrate(memory);
      else reset();
    }
    if (!open && wasOpen) reset();
    wasOpen = open;
  });

  function parseTags(): string[] {
    return [...new Set(tagsInput.split(",").map((tag) => tag.trim()).filter(Boolean))];
  }

  function parseMetadata(): Record<string, unknown> | null {
    if (metadataMode === "keyvalue") return metadataFromRows();
    const raw = metadataInput.trim();
    if (!raw || raw === "null") return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("Metadata must be a JSON object or null.");
    }
    return parsed as Record<string, unknown>;
  }

  function currentEtagFrom(error: ApiError): string | null {
    const body = error.body;
    if (!body || typeof body !== "object") return null;
    const root = body as Record<string, unknown>;
    if (typeof root.current_etag === "string") return root.current_etag;
    if (root.data && typeof root.data === "object") {
      const value = (root.data as Record<string, unknown>).current_etag;
      return typeof value === "string" ? value : null;
    }
    if (root.details && typeof root.details === "object") {
      const value = (root.details as Record<string, unknown>).current_etag;
      return typeof value === "string" ? value : null;
    }
    return null;
  }

  const mutation = createMutation({
    mutationFn: async () => {
      validationError = null;
      const id = memoryId.trim();
      if (!id) throw new Error(scope === "shared" ? "Slug is required." : "Memory key is required.");
      if (!content.trim()) throw new Error("Content is required.");
      const metadata = parseMetadata();
      const tags = parseTags();

      if (mode === "create") {
        const payload: MemoryCreatePayload = {
          id,
          content,
          metadata,
          tags,
        };
        if (scope === "host") {
          const parsedHostId = Number(hostId);
          if (!Number.isInteger(parsedHostId) || parsedHostId <= 0) throw new Error("Host is required.");
          payload.host_id = parsedHostId;
          payload.summary = summary.trim() || null;
          payload.engine = engine === NONE ? null : engine;
        }
        if (scope === "project") {
          if (!projectSlug) throw new Error("Project is required.");
          payload.project_slug = projectSlug;
        }
        if (scope === "shared") {
          payload.title = title.trim() || null;
          payload.summary = summary.trim() || null;
          payload.engine = engine === NONE ? null : engine;
        }
        return memoriesApi.create(scope, payload);
      }

      if (!memory) throw new Error("The selected memory is no longer available.");
      const payload: MemoryUpdatePayload = {
        expected_etag: expectedEtag || memory.etag,
        content,
        metadata,
        tags,
      };
      if (memory.scope === "host") {
        payload.summary = summary.trim() || null;
        payload.engine = engine === NONE ? null : engine;
      }
      if (memory.scope === "shared") {
        payload.summary = summary.trim() || null;
        payload.title = title.trim() || null;
        payload.engine = engine === NONE ? null : engine;
      }
      return memoriesApi.update(memory.scope, memory.record_id, payload);
    },
    onSuccess: (result) => {
      toast.success(mode === "create" ? "Memory created" : result.status === "unchanged" ? "Memory is unchanged" : "Memory updated");
      void qc.invalidateQueries({ queryKey: memoriesKeys.all });
      if (result.memory) {
        qc.setQueryData(memoriesKeys.detail(result.memory.scope, result.memory.record_id), {
          status: "ok",
          memory: result.memory,
        });
        onSaved?.(result.memory);
      }
      setOpen(false);
    },
    onError: (error: unknown) => {
      if (mode === "edit" && error instanceof ApiError && (error.status === 409 || error.code === "memory_conflict")) {
        conflict = { message: error.message, currentEtag: currentEtagFrom(error) };
        return;
      }
      const message = error instanceof Error ? error.message : "Could not save memory";
      validationError = message;
      toast.error(message);
    },
  });

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    conflict = null;
    $mutation.mutate();
  }

  async function reloadLatest(): Promise<void> {
    if (!memory) return;
    reloading = true;
    try {
      const latest = await memoriesApi.detail(memory.scope, memory.record_id);
      qc.setQueryData(memoriesKeys.detail(memory.scope, memory.record_id), latest);
      hydrate(latest.memory);
      toast.success("Latest version loaded");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reload memory");
    } finally {
      reloading = false;
    }
  }

  async function copyDraft(): Promise<void> {
    let metadata: unknown = metadataInput;
    try {
      metadata = parseMetadata();
    } catch {
      /* fall back to the raw textarea contents if it doesn't parse yet */
    }
    const draft = JSON.stringify(
      {
        scope,
        id: memoryId,
        host_id: hostId || null,
        project_slug: projectSlug || null,
        title: title || null,
        summary: summary || null,
        content,
        tags: parseTags(),
        metadata,
        engine: engine === NONE ? null : engine,
      },
      null,
      2,
    );
    const copied = await copyTextToClipboard(draft);
    if (copied) toast.success("Draft copied");
    else toast.error("Could not copy draft");
  }
</script>

<Dialog.Root bind:open onOpenChange={setOpen}>
  <Dialog.Content class="sm:max-w-2xl">
    <form class="flex flex-col gap-4" onsubmit={submit}>
      <Dialog.Header>
        <Dialog.Title>{mode === "create" ? "Create memory" : `Edit ${memory?.id ?? "memory"}`}</Dialog.Title>
        <Dialog.Description>
          {mode === "create"
            ? "Choose its lifecycle scope and immutable owner."
            : "Identity and ownership stay fixed; content and metadata remain editable."}
        </Dialog.Description>
      </Dialog.Header>

      {#if conflict}
        <Alert.Root variant="destructive">
          <AlertTriangle class="h-4 w-4" />
          <Alert.Title>This memory changed elsewhere</Alert.Title>
          <Alert.Description>
            <p>{conflict.message} Your draft is still here.</p>
            {#if conflict.currentEtag}
              <p class="mt-1 font-mono text-[10px]">Current ETag: {conflict.currentEtag}</p>
            {/if}
            <div class="mt-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onclick={reloadLatest} disabled={reloading}>
                <RefreshCw class={reloading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
                Reload latest
              </Button>
              <Button type="button" size="sm" variant="outline" onclick={copyDraft}>
                <Copy class="h-3.5 w-3.5" /> Copy draft
              </Button>
            </div>
          </Alert.Description>
        </Alert.Root>
      {/if}

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for="memory-scope">Scope</Label>
          {#if mode === "create"}
            <Select.Root type="single" value={scope} onValueChange={(value) => value && (scope = value as MemoryScope)}>
              <Select.Trigger id="memory-scope"><Select.Value placeholder="Choose scope">{scope}</Select.Value></Select.Trigger>
              <Select.Content>
                <Select.Item value="shared" label="Shared">Shared · fleet-wide document</Select.Item>
                <Select.Item value="project" label="Project">Project · workspace memory</Select.Item>
                <Select.Item value="host" label="Host">Host · local scratch</Select.Item>
              </Select.Content>
            </Select.Root>
          {:else}
            <Input id="memory-scope" value={scope} disabled />
          {/if}
        </div>

        <div class="grid gap-1.5">
          <Label for="memory-id">{scope === "shared" ? "Slug" : "Memory key"}</Label>
          <Input id="memory-id" bind:value={memoryId} disabled={mode === "edit"} autocomplete="off" spellcheck={false} placeholder={scope === "shared" ? "fleet-runbook" : "decision-key"} />
        </div>

        {#if scope === "host"}
          <div class="grid gap-1.5">
            <Label for="memory-host">Host</Label>
            {#if mode === "create"}
              <Select.Root type="single" value={hostId} onValueChange={(value) => (hostId = value)}>
                <Select.Trigger id="memory-host"><Select.Value placeholder="Choose host">{hosts.find((host) => String(host.id) === hostId)?.fqdn ?? "Choose host"}</Select.Value></Select.Trigger>
                <Select.Content>
                  {#each hosts as host (host.id)}
                    <Select.Item value={String(host.id)} label={host.fqdn}>{host.fqdn}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            {:else}
              <Input id="memory-host" value={memory?.host ?? `Host #${hostId}`} disabled />
            {/if}
          </div>
        {/if}

        {#if scope === "project"}
          <div class="grid gap-1.5">
            <Label for="memory-project">Project</Label>
            {#if mode === "create"}
              <Select.Root type="single" value={projectSlug} onValueChange={(value) => (projectSlug = value)}>
                <Select.Trigger id="memory-project"><Select.Value placeholder="Choose project">{projects.find((project) => project.slug === projectSlug)?.title ?? projectSlug ?? "Choose project"}</Select.Value></Select.Trigger>
                <Select.Content>
                  {#each projects as project (project.slug)}
                    <Select.Item value={project.slug} label={project.title}>{project.title}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            {:else}
              <Input id="memory-project" value={projectSlug} disabled />
            {/if}
          </div>
        {/if}

        {#if scope === "shared"}
          <div class="grid gap-1.5 sm:col-span-2">
            <Label for="memory-title">Display title</Label>
            <Input id="memory-title" bind:value={title} placeholder="Optional human-friendly title" />
          </div>
        {/if}

        {#if scope !== "project"}
          <div class="grid gap-1.5 sm:col-span-2">
            <Label for="memory-summary">Summary</Label>
            <Input id="memory-summary" bind:value={summary} placeholder="A short description for graph and list views" />
          </div>
        {/if}

        <div class="grid gap-1.5">
          <Label for="memory-tags">Tags</Label>
          <Input id="memory-tags" bind:value={tagsInput} placeholder="runbook, auth, mysql" />
          <p class="text-[11px] text-muted-foreground">Comma-separated; explicit tags create graph relationships.</p>
        </div>

        {#if scope !== "project"}
          <div class="grid gap-1.5">
            <Label for="memory-engine">Engine provenance</Label>
            <Select.Root type="single" value={engine} onValueChange={(value) => (engine = value || NONE)}>
              <Select.Trigger id="memory-engine"><Select.Value placeholder="No engine">{engine === NONE ? "No engine" : engine}</Select.Value></Select.Trigger>
              <Select.Content>
                <Select.Item value={NONE} label="No engine">No engine</Select.Item>
                <Select.Item value="codex" label="Codex">Codex</Select.Item>
                <Select.Item value="claude" label="Claude">Claude</Select.Item>
              </Select.Content>
            </Select.Root>
          </div>
        {/if}

        <div class="grid gap-1.5 sm:col-span-2">
          <Label for="memory-content">Content</Label>
          <Textarea id="memory-content" bind:value={content} rows={10} class="font-mono text-xs leading-5" placeholder="Memory content…" />
          <p class="text-right text-[11px] text-muted-foreground">{content.length.toLocaleString()} characters</p>
        </div>

        <div class="grid gap-1.5 sm:col-span-2">
          <Label>Metadata</Label>
          {#if metadataMode === "keyvalue"}
            <KeyValueList bind:rows={metadataRows} keyPlaceholder="key" valuePlaceholder="value" addLabel="Add field" />
          {:else}
            <Alert.Root variant="warning">
              <AlertTriangle class="h-4 w-4" />
              <Alert.Description>
                This record has nested or null metadata values that a simple key/value editor
                can't represent without losing data — edit the raw JSON instead.
              </Alert.Description>
            </Alert.Root>
            <Textarea
              id="memory-metadata"
              aria-label="Metadata (JSON)"
              bind:value={metadataInput}
              rows={5}
              class="font-mono text-xs leading-5"
              spellcheck={false}
            />
          {/if}
        </div>
      </div>

      {#if validationError}
        <p class="text-sm text-destructive" role="alert">{validationError}</p>
      {/if}

      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => setOpen(false)} disabled={$mutation.isPending}>Cancel</Button>
        <Button type="submit" disabled={$mutation.isPending || !memoryId.trim() || !content.trim()}>
          {$mutation.isPending ? "Saving…" : mode === "create" ? "Create memory" : "Save changes"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
