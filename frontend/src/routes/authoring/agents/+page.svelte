<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { agentsApi } from "$lib/api/agents";
  import { hostEngines, hostsListQuery } from "$lib/api/hosts";
  import type { AgentsRenderedDocument, AgentsVersion, AgentsVersionMeta } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import { relativeTime, formatBytes } from "$lib/utils/format";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import * as Select from "$lib/components/ui/select";
  import * as Dialog from "$lib/components/ui/dialog";
  import Save from "@lucide/svelte/icons/save";
  import History from "@lucide/svelte/icons/history";
  import Eye from "@lucide/svelte/icons/eye";
  import * as Card from "$lib/components/ui/card";

  const qc = useQueryClient();

  const query = createQuery({
    queryKey: ["agents"],
    queryFn: () => agentsApi.get(),
  });
  const hosts = hostsListQuery();

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
  // `sha256` is a submit-time integrity check against the *new* content being
  // sent, not an optimistic-concurrency token — the server rejects the write
  // if the hash doesn't match the payload. Never pass the previous version's
  // hash here; that mismatches as soon as `content` has any edit in it.
  const saveMutation = createMutation({
    mutationFn: () => agentsApi.store({ content }),
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
    onSuccess: (result) => {
      // Hydrate the editor from the mutation's own result rather than
      // flipping `hydrated` and waiting on the invalidated query to refetch:
      // that refetch is async, so the re-hydration effect could otherwise
      // fire first against the still-stale cached data and mark itself
      // hydrated before the fresh document arrives, leaving the textarea
      // showing pre-restore content while the version list looks correct.
      content = result.content ?? "";
      serverSha = result.sha256 ?? null;
      hydrated = true;
      toast.success("Restored version");
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

  // A served document is host-specific: the managed block depends on that
  // host's engine, MCP, BrowserOS, and module availability. The admin preview
  // therefore uses the same renderer as the wrapper, rather than composing a
  // best-effort client-side approximation.
  const previewHosts = $derived(
    ($hosts.data?.hosts ?? []).filter((host) => hostEngines(host).includes("codex")),
  );
  let renderedPreview = $state<AgentsRenderedDocument | null>(null);
  let renderedPreviewOpen = $state(false);
  let previewHostId = $state("");
  const renderedPreviewSections = $derived(
    Object.entries(renderedPreview?.sections ?? {})
      .filter(([name]) => name !== "memory_routing")
      .map(([name, section]) => ({ name, section })),
  );

  $effect(() => {
    if (!previewHostId && previewHosts.length > 0) previewHostId = String(previewHosts[0].id);
  });

  const renderedPreviewMutation = createMutation({
    mutationFn: (hostId: number) => agentsApi.render(hostId),
    onSuccess: (data) => {
      renderedPreview = data;
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to render AGENTS.md";
      toast.error(msg);
    },
  });

  function refreshRenderedPreview() {
    const hostId = Number(previewHostId);
    if (!Number.isInteger(hostId) || hostId <= 0) {
      toast.error("Choose a Codex host first");
      return;
    }
    $renderedPreviewMutation.mutate(hostId);
  }

  function openRenderedPreview() {
    renderedPreview = null;
    renderedPreviewOpen = true;
    refreshRenderedPreview();
  }

  const versions = $derived<AgentsVersionMeta[]>($query.data?.versions ?? []);
  const currentVersionId = $derived($query.data?.served_id ?? $query.data?.active_id ?? null);
</script>

<p class="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
  <span>
    This editor stores only the canonical base document — Skills, Memory, Projects, BrowserOS, and
    Secrets guidance is appended per engine and host when served as AGENTS.md or CLAUDE.md.
  </span>
  <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1 whitespace-nowrap text-xs">
    <span>·</span>
    <span>Version <span class="font-mono text-foreground">#{currentVersionId ?? "—"}</span></span>
    <span>·</span>
    <Badge variant={$query.data?.mode === "locked" ? "warning" : "secondary"}>
      {$query.data?.mode ?? "—"}
    </Badge>
    <span>·</span>
    <span>{formatBytes($query.data?.size_bytes ?? 0)}</span>
    <span>·</span>
    <span>Updated {$query.data?.updated_at ? relativeTime($query.data.updated_at) : "—"}</span>
  </span>
</p>

{#if $query.isError}
  <p class="text-sm text-destructive">
    {$query.error instanceof Error ? $query.error.message : "Failed to load AGENTS.md"}
  </p>
{:else}
  <div class="flex flex-col gap-6">
    <!-- Editor -->
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between text-sm">
        <label for="agents-document" class="font-medium">AGENTS.md (Markdown)</label>
        {#if serverSha}
          <span class="font-mono text-xs text-muted-foreground" title={serverSha}>
            sha256: {serverSha.slice(0, 12)}…
          </span>
        {/if}
      </div>
      <Textarea
        id="agents-document"
        class="min-h-[60vh] resize-y font-mono text-sm leading-relaxed"
        spellcheck="false"
        autocomplete="off"
        bind:value={content}
      />
      <div class="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          onclick={openRenderedPreview}
          disabled={$hosts.isPending || previewHosts.length === 0}
        >
          <Eye class="h-4 w-4" />
          Render current
        </Button>
        <Button onclick={() => $saveMutation.mutate()} disabled={$saveMutation.isPending}>
          <Save class="h-4 w-4" />
          {$saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>

    <aside aria-label="Agent document controls" class="border-t pt-5">
      <Card.Root>
        <Card.Content class="divide-y p-0">
          <div class="space-y-2 p-4">
            <h2 class="text-sm font-semibold">Serve mode</h2>
            <Select.Root type="single" bind:value={serveMode as string}>
              <Select.Trigger aria-label="Serve mode">
                <span>{serveMode === "locked" ? "Locked at version" : "Latest"}</span>
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="latest" label="Latest" />
                <Select.Item value="locked" label="Locked at version" />
              </Select.Content>
            </Select.Root>
            {#if serveMode === "locked"}
              <Input
                aria-label="Locked version ID"
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

          <div class="space-y-2 p-4">
            <h2 class="text-sm font-semibold">Retention</h2>
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

          <div class="space-y-2 p-4">
            <h2 class="flex items-center gap-2 text-sm font-semibold">
              <History class="h-4 w-4" />
              Version history
            </h2>
            <p class="text-xs text-muted-foreground">
              Click a version to preview it before restoring — there is no one-click restore.
            </p>
            {#if versions.length === 0}
              <p class="text-xs text-muted-foreground">No versions yet.</p>
            {:else}
              <ul class="space-y-1.5 text-xs">
                {#each versions as v (v.id)}
                  <li class="rounded-md border bg-background px-2 py-1.5">
                    <button
                      type="button"
                      class="flex w-full items-center justify-between gap-2 text-left hover:underline"
                      onclick={() => loadVersion(v.id)}
                    >
                      <span class="flex min-w-0 flex-col">
                        <span class="font-mono">#{v.id}</span>
                        <span class="truncate text-muted-foreground">
                          {v.updated_at ? relativeTime(v.updated_at) : "—"}
                        </span>
                      </span>
                      {#if v.is_served}
                        <Badge variant="success">served</Badge>
                      {:else if v.is_latest}
                        <Badge variant="secondary">latest</Badge>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        </Card.Content>
      </Card.Root>
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
        aria-label="Version preview"
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

<!-- Effective host document preview -->
<Dialog.Root
  open={renderedPreviewOpen}
  onOpenChange={(open) => {
    renderedPreviewOpen = open;
    if (!open) renderedPreview = null;
  }}
>
  <Dialog.Content class="sm:max-w-5xl">
    <Dialog.Header>
      <Dialog.Title>Current rendered AGENTS.md</Dialog.Title>
      <Dialog.Description>
        This is the exact current document the selected Codex host would receive, including its
        managed feature guidance. Unsaved editor changes are intentionally excluded.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-3">
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-[240px] flex-1 space-y-1.5">
          <label for="agents-preview-host" class="text-xs font-medium">Codex host</label>
          <Select.Root
            type="single"
            value={previewHostId}
            onValueChange={(value) => {
              previewHostId = value ?? "";
              renderedPreview = null;
            }}
          >
            <Select.Trigger id="agents-preview-host" aria-label="Codex host for rendered AGENTS preview">
              <Select.Value placeholder="Choose a host">
                {previewHosts.find((host) => String(host.id) === previewHostId)?.fqdn ?? "Choose a host"}
              </Select.Value>
            </Select.Trigger>
            <Select.Content>
              {#each previewHosts as host (host.id)}
                <Select.Item value={String(host.id)} label={host.fqdn}>{host.fqdn} · #{host.id}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <Button onclick={refreshRenderedPreview} disabled={$renderedPreviewMutation.isPending || !previewHostId}>
          <Eye class="h-4 w-4" />
          {$renderedPreviewMutation.isPending ? "Rendering…" : "Refresh"}
        </Button>
      </div>

      {#if $renderedPreviewMutation.isPending}
        <p class="text-sm text-muted-foreground">Rendering the host-specific document…</p>
      {:else if renderedPreview?.status === "missing"}
        <p class="text-sm text-muted-foreground">No AGENTS.md document is currently configured for this host.</p>
      {:else if renderedPreview}
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span class="font-medium text-foreground">{renderedPreview.host_fqdn}</span>
          <span>·</span>
          <span>Version #{renderedPreview.version_id ?? "—"}</span>
          <span>·</span>
          <span>{formatBytes(renderedPreview.size_bytes ?? 0)}</span>
          {#if renderedPreview.sha256}
            <span>·</span>
            <span class="font-mono" title={renderedPreview.sha256}>
              sha256: {renderedPreview.sha256.slice(0, 12)}…
            </span>
          {/if}
        </div>
        {#if renderedPreviewSections.length > 0}
          <div class="flex flex-wrap gap-1.5" aria-label="Managed feature state">
            {#each renderedPreviewSections as { name, section } (name)}
              <Badge variant={section.present ? "success" : "secondary"}>
                {name}: {section.present ? "included" : section.reason}
              </Badge>
            {/each}
          </div>
        {/if}
        <Textarea
          aria-label="Current rendered AGENTS.md preview"
          class="min-h-[55vh] font-mono text-xs"
          readonly
          value={renderedPreview.content ?? ""}
        />
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (renderedPreviewOpen = false)}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
