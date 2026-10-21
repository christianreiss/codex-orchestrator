<script lang="ts">
  /**
   * One role: the operator's draft (manifest and files) with a preview, then
   * publish; steering options (policy) in the metadata block; the timeline of
   * versions, agent proposals and holders below; retiring last.
   *
   * Saving stores the draft only. Nothing reaches agents until "Publish",
   * which creates the next immutable version and tells holders.
   */
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Save from "@lucide/svelte/icons/save";
  import Send from "@lucide/svelte/icons/send";
  import { ApiError } from "$lib/api/client";
  import { rolesApi, rolesKeys, type RoleDetail, type RolePolicy } from "$lib/api/roles";
  import { DocumentEditor, PageShell, StateBlock } from "$lib/components/page";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import RenderedMarkdown from "$lib/components/authoring/RenderedMarkdown.svelte";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { FormField } from "$lib/components/ui/form-field";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Dialog from "$lib/components/ui/dialog";
  import RoleFiles, { type EditableFile } from "./RoleFiles.svelte";
  import RoleTimeline from "./RoleTimeline.svelte";
  import { mutationLabel } from "./role-model";

  let { slug }: { slug: string } = $props();

  const qc = useQueryClient();
  const listHref = `${base}/library?type=roles`;
  const query = createQuery<RoleDetail>(reactiveOptions(() => ({ queryKey: [...rolesKeys.detail(slug)], queryFn: () => rolesApi.get(slug) })));
  const detail = $derived($query.data);
  const currentVersion = $derived(detail?.versions.find((version) => version.id === detail.role.current_version_id) ?? null);

  // ── draft ──────────────────────────────────────────────────────────────
  let manifest = $state("");
  let files = $state<EditableFile[]>([]);
  let hydrated = $state(false);
  let baseline = $state("");
  let submitted = "";
  const draftJson = $derived(JSON.stringify([manifest, files]));
  const dirty = $derived(hydrated && draftJson !== baseline);
  const hasDraft = $derived(!!detail?.draft);

  $effect(() => {
    const data = detail;
    if (!data || hydrated) return;
    void (async () => {
      // Without a draft, start from the current version so an edit begins from what agents run.
      const source = data.draft ?? (currentVersion?.version ? await rolesApi.version(slug, currentVersion.version) : null);
      manifest = source?.manifest ?? "";
      files = (source?.files ?? []).map((file) => ({ path: file.path, blob_sha256: file.sha256, mime_type: file.mime_type, load: file.load, description: file.description, size_bytes: file.size_bytes }));
      baseline = data.draft ? JSON.stringify([manifest, files]) : "";
      hydrated = true;
    })();
  });

  const save = createMutation({
    mutationFn: () => {
      submitted = draftJson;
      return rolesApi.saveDraft(slug, { manifest, files: files.map(({ size_bytes: _size, ...file }) => file) });
    },
    onSuccess: (result) => {
      baseline = submitted;
      // New bodies became blobs on the server: continue from references.
      files = (result.draft?.files ?? []).map((file) => ({ path: file.path, blob_sha256: file.sha256, mime_type: file.mime_type, load: file.load, description: file.description, size_bytes: file.size_bytes }));
      baseline = JSON.stringify([manifest, files]);
      qc.setQueryData(rolesKeys.detail(slug), result);
      toast.success("Draft saved. Agents see it after you publish.");
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "The draft was not saved"),
  });

  let publishOpen = $state(false);
  let changelog = $state("");
  const publish = createMutation({
    mutationFn: () => rolesApi.publish(slug, changelog.trim() || undefined),
    onSuccess: (result) => {
      publishOpen = false;
      changelog = "";
      qc.setQueryData(rolesKeys.detail(slug), result);
      void qc.invalidateQueries({ queryKey: [...rolesKeys.all] });
      toast.success(`Published as version ${result.versions.find((v) => v.id === result.role.current_version_id)?.version ?? ""}`);
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Not published"),
  });

  let discardOpen = $state(false);
  const discard = createMutation({
    mutationFn: () => rolesApi.discardDraft(slug),
    onSuccess: (result) => {
      discardOpen = false;
      qc.setQueryData(rolesKeys.detail(slug), result);
      hydrated = false;
      toast.success("Draft discarded");
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "The draft was not discarded"),
  });

  // ── role settings and policy (separate, explicit save) ─────────────────
  let displayName = $state("");
  let summary = $state("");
  let policy = $state<RolePolicy | null>(null);
  let protectedText = $state("");
  let settingsBaseline = $state("");
  const settingsJson = $derived(JSON.stringify([displayName, summary, policy, protectedText]));
  $effect(() => {
    const role = detail?.role;
    if (!role) return;
    const incoming = JSON.stringify([role.display_name, role.summary, role.policy, role.policy.protected_paths.join("\n")]);
    // Only adopt server state when the operator has no unsaved settings edit.
    if (settingsBaseline === "" || settingsJson === settingsBaseline) {
      displayName = role.display_name;
      summary = role.summary;
      policy = { ...role.policy };
      protectedText = role.policy.protected_paths.join("\n");
      settingsBaseline = incoming;
    }
  });
  const settingsDirty = $derived(settingsBaseline !== "" && settingsJson !== settingsBaseline);
  const saveSettings = createMutation({
    mutationFn: () =>
      rolesApi.update(slug, {
        display_name: displayName.trim(),
        summary: summary.trim(),
        policy: { ...policy!, protected_paths: protectedText.split("\n").map((line) => line.trim()).filter(Boolean) },
        expected_version: detail!.role.version,
      }),
    onSuccess: (result) => {
      settingsBaseline = "";
      qc.setQueryData(rolesKeys.detail(slug), result);
      void qc.invalidateQueries({ queryKey: [...rolesKeys.list()] });
      toast.success("Role settings saved");
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Settings were not saved; reload to see the current values"),
  });

  let retireOpen = $state(false);
  const retire = createMutation({
    mutationFn: (status: "active" | "retired") => rolesApi.update(slug, { status, expected_version: detail!.role.version }),
    onSuccess: (result) => {
      retireOpen = false;
      qc.setQueryData(rolesKeys.detail(slug), result);
      void qc.invalidateQueries({ queryKey: [...rolesKeys.list()] });
      toast.success(result.role.status === "retired" ? "Role retired" : "Role active again");
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Status was not changed"),
  });

  const selectClass = "h-9 w-full rounded-sm border border-input bg-background px-2 text-body";
  const description = $derived(
    detail
      ? `role · ${slug} · ${currentVersion ? `v${currentVersion.version} current` : "not published"} · ${mutationLabel(detail.role.policy.mutation)}${detail.role.status === "retired" ? " · retired" : ""}`
      : "role",
  );
</script>

{#if $query.isLoading}
  <PageShell title={slug} description="role"><StateBlock state="loading" /></PageShell>
{:else if $query.isError || !detail}
  <PageShell title={slug} description="role">
    <StateBlock state="error" message={$query.error instanceof Error ? $query.error.message : "Could not load the role"} onRetry={() => void $query.refetch()} />
    <Button variant="outline" href={listHref} class="w-fit">Back to roles</Button>
  </PageShell>
{:else}
  <DocumentEditor {dirty} pending={$save.isPending} error={$save.error} saved={$save.isSuccess} title={detail.role.display_name} {description}>
    {#snippet actions()}
      <Button variant="outline" href={listHref}><ArrowLeft class="h-4 w-4" />Back</Button>
      <Button variant="outline" onclick={() => $save.mutate()} disabled={$save.isPending || !hydrated}>
        <Save class="h-4 w-4" />
        {$save.isPending ? "Saving…" : "Save draft"}
      </Button>
      <Button onclick={() => (publishOpen = true)} disabled={!hasDraft || dirty || $publish.isPending}>
        <Send class="h-4 w-4" />
        Publish
      </Button>
    {/snippet}
    {#snippet body()}
      <div class="space-y-2">
        <p class="text-body-sm text-muted-foreground">
          {#if hasDraft}
            You are editing an unpublished draft{currentVersion ? ` based on v${currentVersion.version}` : ""}. Publish to create the next version; running agents stay on theirs until they switch.
          {:else if currentVersion}
            Showing v{currentVersion.version}. Saving creates a draft; agents keep improving the published role meanwhile.
          {:else}
            Write the role prompt, save the draft and publish version 1.
          {/if}
        </p>
        <label for="role-manifest" class="text-body font-medium">Role manifest (ROLE.md)</label>
        <Textarea id="role-manifest" class="min-h-[50vh] resize-y font-mono text-base leading-relaxed" spellcheck="false" autocomplete="off" bind:value={manifest} />
        <p class="text-body-sm text-muted-foreground">
          YAML frontmatter with <code class="font-mono">name: {slug}</code>, then the role prompt. Optional: <code class="font-mono">label</code> (session titles show "(Name) (Label) …"),
          <code class="font-mono">summary</code>, <code class="font-mono">boundaries</code>, <code class="font-mono">tools</code>, <code class="font-mono">collaboration</code>.
        </p>
      </div>
      <div class="space-y-2">
        <h2 class="text-body font-semibold">Support files</h2>
        <RoleFiles bind:files />
      </div>
      {#if hasDraft}
        <Button variant="ghost" size="sm" class="w-fit" onclick={() => (discardOpen = true)}>Discard draft</Button>
      {/if}
    {/snippet}
    {#snippet preview()}
      <div class="space-y-2">
        <span class="text-body font-medium">Rendered preview</span>
        <RenderedMarkdown source={manifest} />
      </div>
    {/snippet}
    {#snippet settings()}
      {#if policy}
        <div role="group" aria-label="Role settings" class="space-y-3">
          <FormField id="role-display-name" label="Name"><Input id="role-display-name" bind:value={displayName} /></FormField>
          <FormField id="role-summary" label="Catalog summary" hint="What agents read when choosing a role.">
            <Textarea id="role-summary" rows={3} maxlength={600} bind:value={summary} aria-describedby="role-summary-hint" />
          </FormField>
          <FormField id="role-mutation" label="Improvement by agents" hint="Self-improving publishes checked changes on its own; supervised holds each for you; frozen holds everything.">
            <select id="role-mutation" class={selectClass} bind:value={policy.mutation} aria-describedby="role-mutation-hint">
              <option value="autonomous">Self-improving</option>
              <option value="supervised">Supervised</option>
              <option value="frozen">Frozen</option>
            </select>
          </FormField>
          <FormField id="role-upgrade" label="When holders move to a new version">
            <select id="role-upgrade" class={selectClass} bind:value={policy.holder_upgrade}>
              <option value="at_task_boundary">On their own, between two tasks</option>
              <option value="manual">Only when their principal says so</option>
            </select>
          </FormField>
          <FormField id="role-budget" label="Versions per 24 hours" hint="Further proposals are held for you once reached.">
            <Input id="role-budget" type="number" min={0} max={1000} bind:value={policy.daily_budget} aria-describedby="role-budget-hint" />
          </FormField>
          <FormField id="role-protected" label="Protected paths" hint="One per line; ROLE.md protects the role prompt. Changes to them wait for you.">
            <Textarea id="role-protected" rows={3} class="font-mono" bind:value={protectedText} aria-describedby="role-protected-hint" />
          </FormField>
          <div class="flex items-center gap-3">
            <Button variant="outline" onclick={() => $saveSettings.mutate()} disabled={!settingsDirty || $saveSettings.isPending}>
              {$saveSettings.isPending ? "Saving…" : "Save settings"}
            </Button>
            <span class="text-body-sm text-muted-foreground" role="status">
              {settingsDirty ? "Unsaved settings" : $saveSettings.isError ? "Settings were not saved" : "Settings saved"}
            </span>
          </div>
        </div>
      {/if}
    {/snippet}
    {#snippet history()}
      <RoleTimeline {slug} {detail} />
    {/snippet}
    {#snippet danger()}
      <p class="mb-2 text-body-sm text-muted-foreground">
        {detail.role.status === "retired"
          ? "This role is retired: it is hidden from the catalog and cannot be activated. Agents still holding it keep their version."
          : "Retiring hides the role from the catalog and blocks new activations. Agents holding it keep their version; history is kept."}
      </p>
      {#if detail.role.status === "retired"}
        <Button variant="outline" disabled={$retire.isPending} onclick={() => $retire.mutate("active")}>Make the role active again</Button>
      {:else}
        <Button variant="destructive" disabled={$retire.isPending} onclick={() => (retireOpen = true)}>Retire role</Button>
      {/if}
    {/snippet}
  </DocumentEditor>
{/if}

<Dialog.Root bind:open={publishOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Publish {slug} v{(detail?.versions[0]?.version ?? 0) + 1}</Dialog.Title>
      <Dialog.Description>Creates an immutable version. New activations use it; existing holders find updates in role history and switch at their next task boundary unless the role says otherwise.</Dialog.Description>
    </Dialog.Header>
    <FormField id="role-changelog" label="Changelog" hint="Optional; shown in version history.">
      <Textarea id="role-changelog" rows={3} bind:value={changelog} aria-describedby="role-changelog-hint" />
    </FormField>
    <Dialog.Footer class="gap-2">
      <Button variant="outline" onclick={() => (publishOpen = false)}>Cancel</Button>
      <Button disabled={$publish.isPending} onclick={() => $publish.mutate()}>{$publish.isPending ? "Publishing…" : "Publish"}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={discardOpen}
  title="Discard draft"
  description={`The unpublished draft of ${slug} is removed. Published versions are not affected.`}
  confirmLabel="Discard draft"
  destructive
  busy={$discard.isPending}
  onConfirm={() => $discard.mutate()}
/>

<ConfirmDialog
  bind:open={retireOpen}
  title="Retire role"
  description={`${slug} disappears from the catalog and cannot be activated. Holders keep their version; versions and history are kept.`}
  confirmLabel="Retire role"
  destructive
  busy={$retire.isPending}
  onConfirm={() => $retire.mutate("retired")}
/>
