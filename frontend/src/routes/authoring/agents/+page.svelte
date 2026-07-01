<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { agentsApi } from "$lib/api/agents";
  import type { AgentsVersion, AgentsVersionMeta } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import { relativeTime, formatBytes } from "$lib/utils/format";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import * as Select from "$lib/components/ui/select";
  import * as Dialog from "$lib/components/ui/dialog";
  import Save from "@lucide/svelte/icons/save";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import History from "@lucide/svelte/icons/history";

  const qc = useQueryClient();

  const query = createQuery({
    queryKey: ["agents"],
    queryFn: () => agentsApi.get(),
  });

  // Editor content + hydration tracking
  let content = $state("");
  let serverSha = $state<string | null>(null);
  let hydrated = $state(false);

  // Version preview state
  let viewingVersion = $state<AgentsVersion | null>(null);
  const versionQuery = createMutation({
    mutationFn: (id: number) => agentsApi.getVersion(id),
    onSuccess: (data) => {
      viewingVersion = data;
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to load version";
      toast.error(msg);
    },
  });

  $effect(() => {
    const data = $query.data;
    if (data && !hydrated && data.status !== "missing") {
      content = data.content ?? "";
      serverSha = data.sha256 ?? null;
      hydrated = true;
    } else if (data && !hydrated && data.status === "missing") {
      content = "";
      serverSha = null;
      hydrated = true;
    }
  });

  // ---- Save ----
  const saveMutation = createMutation({
    mutationFn: () => agentsApi.store({ content, sha256: serverSha }),
    onSuccess: (result) => {
      serverSha = result.sha256 ?? null;
      toast.success(
        result.status === "unchanged"
          ? "No changes to save"
          : `Stored version #${result.version_id ?? "?"}`,
      );
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to save";
      toast.error(msg);
    },
  });

  // ---- Serve mode ----
  let serveMode = $state<"latest" | "locked">("latest");
  let serveLockedId = $state<number | null>(null);
  let serveHydrated = $state(false);

  $effect(() => {
    const data = $query.data;
    if (!serveHydrated && (data?.mode === "latest" || data?.mode === "locked")) {
      serveMode = data.mode;
      serveLockedId = data.served_id ?? data.active_id ?? null;
      serveHydrated = true;
    }
  });

  const serveMutation = createMutation({
    mutationFn: (payload: { mode: "latest" | "locked"; version_id?: number | null }) =>
      agentsApi.serve(payload),
    onSuccess: () => {
      toast.success("Serve mode updated");
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to update serve mode";
      toast.error(msg);
    },
  });

  function applyServeMode() {
    if (serveMode === "locked" && (!serveLockedId || serveLockedId <= 0)) {
      toast.error("Pick a version to lock to");
      return;
    }
    $serveMutation.mutate({
      mode: serveMode,
      version_id: serveMode === "locked" ? serveLockedId : null,
    });
  }

  // ---- Retention ----
  let retentionInput = $state<number>(20);
  let retentionHydrated = $state(false);
  $effect(() => {
    const lim = $query.data?.backup_limit;
    if (typeof lim === "number" && !retentionHydrated) {
      retentionInput = lim;
      retentionHydrated = true;
    }
  });

  const retentionMutation = createMutation({
    mutationFn: () => agentsApi.retention({ backup_limit: retentionInput }),
    onSuccess: () => {
      toast.success("Retention updated");
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to update retention";
      toast.error(msg);
    },
  });

  // ---- Revert ----
  const revertMutation = createMutation({
    mutationFn: (id: number) => agentsApi.revert({ version_id: id }),
    onSuccess: () => {
      toast.success("Restored version");
      hydrated = false; // re-hydrate from server
      viewingVersion = null;
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to restore";
      toast.error(msg);
    },
  });

  function loadVersion(id: number) {
    $versionQuery.mutate(id);
  }

  function closeVersion() {
    viewingVersion = null;
  }

  function makeVersionCurrent() {
    if (!viewingVersion) return;
    $revertMutation.mutate(viewingVersion.id);
  }

  const versions = $derived<AgentsVersionMeta[]>($query.data?.versions ?? []);
  const currentVersionId = $derived($query.data?.served_id ?? $query.data?.active_id ?? null);
</script>

<section class="mb-4 flex flex-wrap items-center gap-4 rounded-lg border bg-card p-4 text-sm">
  <div class="flex flex-col">
    <span class="text-xs uppercase tracking-wide text-muted-foreground">Current version</span>
    <span class="font-mono text-sm">#{currentVersionId ?? "—"}</span>
  </div>
  <div class="flex flex-col">
    <span class="text-xs uppercase tracking-wide text-muted-foreground">Serve mode</span>
    <Badge variant={$query.data?.mode === "locked" ? "warning" : "secondary"}>
      {$query.data?.mode ?? "—"}
    </Badge>
  </div>
  <div class="flex flex-col">
    <span class="text-xs uppercase tracking-wide text-muted-foreground">Size</span>
    <span>{formatBytes($query.data?.size_bytes ?? 0)}</span>
  </div>
  <div class="flex flex-col">
    <span class="text-xs uppercase tracking-wide text-muted-foreground">Updated</span>
    <span>{$query.data?.updated_at ? relativeTime($query.data.updated_at) : "—"}</span>
  </div>
</section>

{#if $query.isError}
  <p class="text-sm text-destructive">
    {$query.error instanceof Error ? $query.error.message : "Failed to load AGENTS.md"}
  </p>
{:else}
  <div class="grid gap-6 lg:grid-cols-[1fr_320px]">
    <!-- Editor -->
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between text-sm">
        <span class="font-medium">AGENTS.md (Markdown)</span>
        {#if serverSha}
          <span class="font-mono text-xs text-muted-foreground" title={serverSha}>
            sha256: {serverSha.slice(0, 12)}…
          </span>
        {/if}
      </div>
      <Textarea
        class="min-h-[60vh] resize-y font-mono text-sm leading-relaxed"
        spellcheck="false"
        autocomplete="off"
        bind:value={content}
      />
      <div class="flex items-center justify-end gap-2">
        <Button onclick={() => $saveMutation.mutate()} disabled={$saveMutation.isPending}>
          <Save class="h-4 w-4" />
          {$saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>

    <!-- Side panel -->
    <aside class="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 text-sm font-semibold">Serve mode</h3>
        <div class="space-y-2">
          <Select.Root type="single" bind:value={serveMode as string}>
            <Select.Trigger>
              <span>{serveMode === "locked" ? "Locked at version" : "Latest"}</span>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="latest" label="Latest" />
              <Select.Item value="locked" label="Locked at version" />
            </Select.Content>
          </Select.Root>
          {#if serveMode === "locked"}
            <Input
              type="number"
              placeholder="Version ID"
              bind:value={serveLockedId}
              min={1}
            />
          {/if}
          <Button size="sm" onclick={applyServeMode} disabled={$serveMutation.isPending}>
            Apply
          </Button>
        </div>
      </div>

      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 text-sm font-semibold">Retention</h3>
        <div class="flex items-end gap-2">
          <div class="flex-1 space-y-1.5">
            <label for="retention-days" class="text-xs font-medium">Backups to keep</label>
            <Input id="retention-days" type="number" min={0} max={200} bind:value={retentionInput} />
          </div>
          <Button
            size="sm"
            variant="outline"
            onclick={() => $retentionMutation.mutate()}
            disabled={$retentionMutation.isPending}
          >
            Save
          </Button>
        </div>
      </div>

      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold">
          <History class="h-4 w-4" />
          Version history
        </h3>
        {#if versions.length === 0}
          <p class="text-xs text-muted-foreground">No versions yet.</p>
        {:else}
          <ul class="space-y-1.5 text-xs">
            {#each versions as v (v.id)}
              <li class="flex items-center justify-between gap-2 rounded-md border bg-background px-2 py-1.5">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 flex-col text-left hover:underline"
                  onclick={() => loadVersion(v.id)}
                >
                  <span class="font-mono">#{v.id}</span>
                  <span class="truncate text-muted-foreground">
                    {v.updated_at ? relativeTime(v.updated_at) : "—"}
                  </span>
                </button>
                <div class="flex items-center gap-1">
                  {#if v.is_served}
                    <Badge variant="success">served</Badge>
                  {:else if v.is_latest}
                    <Badge variant="secondary">latest</Badge>
                  {/if}
                  <Button
                    size="sm"
                    variant="ghost"
                    onclick={() => $revertMutation.mutate(v.id)}
                    disabled={$revertMutation.isPending}
                  >
                    <RotateCcw class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </aside>
  </div>
{/if}

<!-- Version preview dialog -->
<Dialog.Root open={!!viewingVersion} onOpenChange={(v) => (v ? null : closeVersion())}>
  <Dialog.Content class="sm:max-w-3xl">
    <Dialog.Header>
      <Dialog.Title>
        Version #{viewingVersion?.id}
      </Dialog.Title>
      <Dialog.Description>
        Read-only preview. Use "Make current" to restore this version as the new active document.
      </Dialog.Description>
    </Dialog.Header>
    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{viewingVersion?.updated_at ? relativeTime(viewingVersion.updated_at) : ""}</span>
        <span>·</span>
        <span class="font-mono">sha256: {viewingVersion?.sha256?.slice(0, 12)}…</span>
        <span>·</span>
        <span>{formatBytes(viewingVersion?.size_bytes ?? 0)}</span>
      </div>
      <Textarea
        class="min-h-[50vh] font-mono text-xs"
        readonly
        value={viewingVersion?.content ?? ""}
      />
    </div>
    <Dialog.Footer class="flex justify-end gap-2">
      <Button variant="outline" onclick={closeVersion}>Close</Button>
      <Button onclick={makeVersionCurrent} disabled={$revertMutation.isPending}>
        Make current
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
