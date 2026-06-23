<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { claudeSettingsApi, claudeSettingsKeys } from "$lib/api/claudeSettings";
  import type { ClaudeConfigResponse, ClaudeConfigSettings } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import {
    ADVISOR_MODELS,
    ADVISOR_OFF,
    CLAUDE_MODELS,
    CLAUDE_PERMISSION_MODES,
    DEFAULT_CLAUDE_PERMISSION_MODE,
    INHERIT_MODEL,
  } from "$lib/constants/models";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Badge } from "$lib/components/ui/badge";
  import { ModelSelect } from "$lib/components/ui/model-select";
  import RepeatableList from "$lib/components/authoring/RepeatableList.svelte";
  import KeyValueList from "$lib/components/authoring/KeyValueList.svelte";
  import type { KeyValueRow } from "$lib/components/authoring/KeyValueList.svelte";
  import HooksEditor from "$lib/components/authoring/HooksEditor.svelte";
  import type { HooksMap } from "$lib/components/authoring/HooksEditor.svelte";
  import MdPreview from "$lib/components/authoring/MdPreview.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Save from "@lucide/svelte/icons/save";

  const qc = useQueryClient();

  const query = createQuery<ClaudeConfigResponse>({
    queryKey: claudeSettingsKeys.config(),
    queryFn: () => claudeSettingsApi.get(),
  });

  // ---- Local editor state ----
  let model = $state(INHERIT_MODEL);
  let env = $state<KeyValueRow[]>([]);
  let allow = $state<string[]>([]);
  let ask = $state<string[]>([]);
  let deny = $state<string[]>([]);
  let permissionMode = $state(DEFAULT_CLAUDE_PERMISSION_MODE);
  let statusLineCommand = $state("");
  let advisorModel = $state(ADVISOR_OFF);
  let hooks = $state<HooksMap>({});
  let serverSha = $state<string | null>(null);
  let hydrated = $state(false);

  function envFromRecord(record: Record<string, string> | undefined): KeyValueRow[] {
    if (!record) return [];
    return Object.entries(record).map(([key, value]) => ({ key, value: String(value ?? "") }));
  }

  function hooksFromConfig(raw: ClaudeConfigSettings["hooks"]): HooksMap {
    const out: HooksMap = {};
    if (!raw) return out;
    for (const [event, entries] of Object.entries(raw)) {
      out[event] = (entries ?? []).map((e) => ({
        matcher: typeof e.matcher === "string" ? e.matcher : "",
        commands: Array.isArray(e.commands) ? e.commands.map((c) => String(c)) : [],
      }));
    }
    return out;
  }

  $effect(() => {
    const data = $query.data;
    if (data && !hydrated) {
      const s = data.settings ?? {};
      model = s.model || INHERIT_MODEL;
      env = envFromRecord(s.env);
      allow = [...(s.permissions?.allow ?? [])];
      ask = [...(s.permissions?.ask ?? [])];
      deny = [...(s.permissions?.deny ?? [])];
      permissionMode = s.permissionMode || DEFAULT_CLAUDE_PERMISSION_MODE;
      statusLineCommand = typeof s.statusLine?.command === "string" ? s.statusLine.command : "";
      advisorModel = s.advisorModel || ADVISOR_OFF;
      hooks = hooksFromConfig(s.hooks);
      serverSha = data.sha256 ?? null;
      hydrated = true;
    }
  });


  // Build the canonical settings object from local state (omit empty blocks).
  const builtSettings = $derived.by<ClaudeConfigSettings>(() => {
    const out: ClaudeConfigSettings = {};
    if (model && model !== INHERIT_MODEL) out.model = model;

    const envObj: Record<string, string> = {};
    for (const row of env) {
      const key = row.key.trim();
      if (key) envObj[key] = row.value;
    }
    if (Object.keys(envObj).length) out.env = envObj;

    const allowList = allow.filter((v) => v.trim() !== "");
    const askList = ask.filter((v) => v.trim() !== "");
    const denyList = deny.filter((v) => v.trim() !== "");
    if (allowList.length || askList.length || denyList.length) {
      out.permissions = {};
      if (allowList.length) out.permissions.allow = allowList;
      if (askList.length) out.permissions.ask = askList;
      if (denyList.length) out.permissions.deny = denyList;
    }

    if (permissionMode) out.permissionMode = permissionMode;

    if (statusLineCommand.trim()) {
      out.statusLine = { type: "command", command: statusLineCommand.trim() };
    }

    const hooksObj: NonNullable<ClaudeConfigSettings["hooks"]> = {};
    for (const [event, rows] of Object.entries(hooks)) {
      const cleaned = rows
        .map((r) => ({
          matcher: r.matcher,
          commands: r.commands.filter((c) => c.trim() !== ""),
        }))
        .filter((r) => r.matcher.trim() !== "" || r.commands.length > 0);
      if (cleaned.length) hooksObj[event] = cleaned;
    }
    if (Object.keys(hooksObj).length) out.hooks = hooksObj;

    if (advisorModel && advisorModel !== ADVISOR_OFF) out.advisorModel = advisorModel;

    return out;
  });

  // ---- Save ----
  const saveMutation = createMutation({
    mutationFn: () => claudeSettingsApi.store({ settings: builtSettings, sha256: serverSha }),
    onSuccess: (result) => {
      serverSha = result.sha256 ?? serverSha;
      toast.success(result.status === "unchanged" ? "No changes to save" : "Settings saved");
      void qc.invalidateQueries({ queryKey: claudeSettingsKeys.config() });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to save settings");
    },
  });
</script>

<section class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-sm">
  <div class="flex flex-col">
    <span class="text-xs uppercase tracking-wide text-muted-foreground">Fleet settings</span>
    <span class="text-sm">Claude settings.json sub-blocks</span>
  </div>
  {#if serverSha}
    <div class="flex flex-col">
      <span class="text-xs uppercase tracking-wide text-muted-foreground">sha256</span>
      <span class="font-mono text-xs" title={serverSha}>{serverSha.slice(0, 12)}…</span>
    </div>
  {/if}
  <div class="ml-auto flex items-center gap-2">
    <Button
      variant="outline"
      size="sm"
      onclick={() => void qc.invalidateQueries({ queryKey: claudeSettingsKeys.config() })}
      disabled={$query.isFetching}
    >
      <RefreshCw class={$query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      Refresh
    </Button>
    <Button size="sm" onclick={() => $saveMutation.mutate()} disabled={$saveMutation.isPending}>
      <Save class="h-4 w-4" />
      {$saveMutation.isPending ? "Saving…" : "Save"}
    </Button>
  </div>
</section>

{#if $query.isLoading}
  <p class="text-sm text-muted-foreground">Loading settings…</p>
{:else if $query.isError}
  <p class="text-sm text-destructive">
    {$query.error instanceof Error ? $query.error.message : "Failed to load settings"}
  </p>
{:else}
  <div class="grid gap-6 lg:grid-cols-[1fr_360px]">
    <div class="flex flex-col gap-6">
      <!-- Model -->
      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 text-sm font-semibold">Model</h3>
        <ModelSelect bind:value={model} options={CLAUDE_MODELS} label="Model" placeholder="Inherit" fallback={INHERIT_MODEL} />
      </div>

      <!-- Advisor model (experimental) -->
      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-1 text-sm font-semibold">
          Advisor model
          <Badge variant="secondary" class="ml-1 align-middle">experimental</Badge>
        </h3>
        <p class="mb-3 text-xs text-muted-foreground">
          Sets <span class="font-mono">advisorModel</span> in settings.json. When set, the advisor tool
          routes the full transcript to a stronger reviewer model. Off omits the key.
        </p>
        <ModelSelect bind:value={advisorModel} options={ADVISOR_MODELS} label="Advisor model" placeholder="Off" fallback={ADVISOR_OFF} />
      </div>

      <!-- Env -->
      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 text-sm font-semibold">Environment variables</h3>
        <KeyValueList bind:rows={env} keyPlaceholder="NAME" valuePlaceholder="value" addLabel="Add variable" />
      </div>

      <!-- Permission mode -->
      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-1 text-sm font-semibold">Permission mode</h3>
        <p class="mb-3 text-xs text-muted-foreground">
          Sets <span class="font-mono">permissions.defaultMode</span> in settings.json — the mode every
          managed Claude host starts in. <span class="font-mono">auto</span> auto-approves tool calls with
          background safety checks; <span class="font-mono">default</span> prompts each time.
        </p>
        <ModelSelect
          bind:value={permissionMode}
          options={CLAUDE_PERMISSION_MODES}
          label="Permission mode"
          fallback={DEFAULT_CLAUDE_PERMISSION_MODE}
        />
      </div>

      <!-- Permissions -->
      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 text-sm font-semibold">Permissions</h3>
        <div class="space-y-4">
          <div class="space-y-1.5">
            <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Allow</span>
            <RepeatableList bind:items={allow} placeholder="e.g. Bash(npm run *)" addLabel="Add allow rule" />
          </div>
          <div class="space-y-1.5">
            <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Ask</span>
            <RepeatableList bind:items={ask} placeholder="e.g. Bash(git push *)" addLabel="Add ask rule" />
          </div>
          <div class="space-y-1.5">
            <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Deny</span>
            <RepeatableList bind:items={deny} placeholder="e.g. Read(./secrets/**)" addLabel="Add deny rule" />
          </div>
        </div>
      </div>

      <!-- Status line -->
      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 text-sm font-semibold">Status line</h3>
        <div class="space-y-1.5">
          <label for="status-line-command" class="text-xs font-medium">Command</label>
          <Input id="status-line-command" bind:value={statusLineCommand} placeholder="e.g. ~/.claude/statusline.sh" />
          <p class="text-xs text-muted-foreground">Type is fixed to <span class="font-mono">command</span>.</p>
        </div>
      </div>

      <!-- Hooks -->
      <div class="rounded-lg border bg-card p-4">
        <h3 class="mb-3 text-sm font-semibold">Hooks</h3>
        <HooksEditor bind:hooks />
      </div>
    </div>

    <!-- Preview -->
    <aside class="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
      <div class="flex items-center justify-between text-sm">
        <span class="font-medium">settings.json preview</span>
        <Badge variant="secondary">read-only</Badge>
      </div>
      <MdPreview json={builtSettings} />
    </aside>
  </div>
{/if}
