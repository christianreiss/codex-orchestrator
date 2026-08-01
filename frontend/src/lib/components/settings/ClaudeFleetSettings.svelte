<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { claudeSettingsApi, claudeSettingsKeys } from "$lib/api/claudeSettings";
  import type { ClaudeConfigResponse, ClaudeConfigSettings } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import {
    ADVISOR_MODELS,
    ADVISOR_OFF,
    CLAUDE_PERMISSION_MODES,
    DEFAULT_CLAUDE_PERMISSION_MODE,
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
  import SaveIndicator from "./SaveIndicator.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Save from "@lucide/svelte/icons/save";

  const qc = useQueryClient();

  const query = createQuery<ClaudeConfigResponse>({
    queryKey: claudeSettingsKeys.config(),
    queryFn: () => claudeSettingsApi.get(),
  });

  // ---- Local editor state ----
  let env = $state<KeyValueRow[]>([]);
  let allow = $state<string[]>([]);
  let ask = $state<string[]>([]);
  let deny = $state<string[]>([]);
  let permissionMode = $state(DEFAULT_CLAUDE_PERMISSION_MODE);
  let statusLineCommand = $state("");
  let advisorModel = $state(ADVISOR_OFF);
  let hooks = $state<HooksMap>({});
  let serverSha = $state<string | null>(null);
  let savedAt = $state<Date | null>(null);
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
    if (!data) return;
    serverSha = data.sha256 ?? null;
    if (hydrated) return;

    const s = data.settings ?? {};
    env = envFromRecord(s.env);
    allow = [...(s.permissions?.allow ?? [])];
    ask = [...(s.permissions?.ask ?? [])];
    deny = [...(s.permissions?.deny ?? [])];
    permissionMode = s.permissionMode || DEFAULT_CLAUDE_PERMISSION_MODE;
    statusLineCommand = typeof s.statusLine?.command === "string" ? s.statusLine.command : "";
    advisorModel = s.advisorModel || ADVISOR_OFF;
    hooks = hooksFromConfig(s.hooks);
    hydrated = true;
  });


  // Build the canonical settings object from local state (omit empty blocks).
  const builtSettings = $derived.by<ClaudeConfigSettings>(() => {
    const out: ClaudeConfigSettings = {};

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
    mutationFn: async () => {
      const remainingSettings = { ...builtSettings };
      const latest = await claudeSettingsApi.get();
      const latestSettings = latest.settings ?? {};
      const settings: ClaudeConfigSettings = { ...remainingSettings };

      // Fleet model defaults are edited separately. Re-read them immediately
      // before this store and use the matching SHA so a stale editor cannot
      // overwrite a newer model or reasoning-effort selection.
      if ("model" in latestSettings) settings.model = latestSettings.model;
      if ("effortLevel" in latestSettings) settings.effortLevel = latestSettings.effortLevel;

      return claudeSettingsApi.store({ settings, sha256: latest.sha256 ?? null });
    },
    onSuccess: (result) => {
      serverSha = result.sha256 ?? serverSha;
      savedAt = new Date();
      toast.success(result.change === "unchanged" ? "No changes to save" : "Settings saved");
      void qc.invalidateQueries({ queryKey: claudeSettingsKeys.config() });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to save settings");
    },
  });

  const saveStatus = $derived.by(() => {
    if ($saveMutation.isPending) return "saving" as const;
    if ($saveMutation.isError) return "error" as const;
    if (savedAt) return "saved" as const;
    return "idle" as const;
  });
</script>

<section
  id="claude-fleet-settings"
  class="scroll-mt-24 border-y border-border py-3 text-sm"
>
  <div class="flex flex-wrap items-center gap-3">
    <div class="min-w-0">
      <p class="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Fleet configuration</p>
      <p class="text-sm">Claude Code <span class="font-mono text-xs">settings.json</span> sub-blocks</p>
    </div>
    {#if serverSha}
      <div class="border-l pl-3">
        <span class="block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Revision</span>
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
        {$saveMutation.isPending ? "Saving…" : "Save changes"}
      </Button>
    </div>
  </div>
  <div class="mt-2 max-w-md" aria-live="polite">
    <SaveIndicator
      status={saveStatus}
      {savedAt}
      error={$saveMutation.error instanceof Error ? $saveMutation.error.message : null}
    />
  </div>
</section>

{#if $query.isLoading}
  <p class="text-sm text-muted-foreground">Loading settings…</p>
{:else if $query.isError}
  <p class="text-sm text-destructive">
    {$query.error instanceof Error ? $query.error.message : "Failed to load settings"}
  </p>
{:else}
  <div class="divide-y border-b border-border">
    <section class="py-5" aria-labelledby="advisor-model-heading">
      <div class="mb-3 max-w-3xl">
        <h3 id="advisor-model-heading" class="text-sm font-semibold">
          Advisor model
          <Badge variant="secondary" class="ml-1 align-middle">experimental</Badge>
        </h3>
        <p class="mt-1 text-sm text-muted-foreground">
          Sets <span class="font-mono">advisorModel</span> in settings.json. When set, the advisor tool
          routes the full transcript to a stronger reviewer model. Off omits the key.
        </p>
      </div>
      <ModelSelect bind:value={advisorModel} options={ADVISOR_MODELS} label="Advisor model" placeholder="Off" fallback={ADVISOR_OFF} />
    </section>

    <section class="py-5" aria-labelledby="environment-variables-heading">
      <div class="mb-3 max-w-3xl">
        <h3 id="environment-variables-heading" class="text-sm font-semibold">Environment variables</h3>
        <p class="mt-1 text-sm text-muted-foreground">Values are rendered only into fleet-owned Claude settings.</p>
      </div>
      <KeyValueList bind:rows={env} keyPlaceholder="NAME" valuePlaceholder="value" addLabel="Add variable" />
    </section>

    <section class="py-5" aria-labelledby="permission-mode-heading">
      <div class="mb-3 max-w-3xl">
        <h3 id="permission-mode-heading" class="text-sm font-semibold">Permission mode</h3>
        <p class="mt-1 text-sm text-muted-foreground">
          Sets <span class="font-mono">permissions.defaultMode</span> in settings.json — the mode every
          managed Claude host starts in. <span class="font-mono">auto</span> auto-approves tool calls with
          background safety checks; <span class="font-mono">default</span> prompts each time.
        </p>
      </div>
      <ModelSelect
        bind:value={permissionMode}
        options={CLAUDE_PERMISSION_MODES}
        label="Permission mode"
        fallback={DEFAULT_CLAUDE_PERMISSION_MODE}
      />
    </section>

    <section class="py-5" aria-labelledby="permissions-heading">
      <div class="mb-3 max-w-3xl">
        <h3 id="permissions-heading" class="text-sm font-semibold">Permissions</h3>
        <p class="mt-1 text-sm text-muted-foreground">Allow rules run directly, ask rules require confirmation, and deny rules are never offered.</p>
      </div>
      <div class="divide-y border-y border-border">
        <div class="py-4">
          <p class="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Allow</p>
          <RepeatableList bind:items={allow} placeholder="e.g. Bash(npm run *)" addLabel="Add allow rule" />
        </div>
        <div class="py-4">
          <p class="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Ask</p>
          <RepeatableList bind:items={ask} placeholder="e.g. Bash(git push *)" addLabel="Add ask rule" />
        </div>
        <div class="py-4">
          <p class="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Deny</p>
          <RepeatableList bind:items={deny} placeholder="e.g. Read(./secrets/**)" addLabel="Add deny rule" />
        </div>
      </div>
    </section>

    <section class="py-5" aria-labelledby="status-line-heading">
      <div class="mb-3 max-w-3xl">
        <h3 id="status-line-heading" class="text-sm font-semibold">Status line</h3>
        <p class="mt-1 text-sm text-muted-foreground">Type is fixed to <span class="font-mono text-xs">command</span>.</p>
      </div>
      <div class="max-w-2xl space-y-1.5">
        <label for="status-line-command" class="text-xs font-medium">Command</label>
        <Input id="status-line-command" bind:value={statusLineCommand} placeholder="e.g. ~/.claude/statusline.sh" />
      </div>
    </section>

    <section class="py-5" aria-labelledby="hooks-heading">
      <div class="mb-3 max-w-3xl">
        <h3 id="hooks-heading" class="text-sm font-semibold">Hooks</h3>
        <p class="mt-1 text-sm text-muted-foreground">Run selected commands when matching Claude lifecycle events occur.</p>
      </div>
      <HooksEditor bind:hooks />
    </section>

    <section class="py-5" aria-labelledby="settings-preview-heading">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="settings-preview-heading" class="text-sm font-semibold">settings.json preview</h3>
          <p class="mt-1 text-sm text-muted-foreground">Read-only effective fleet-owned settings before save.</p>
        </div>
        <Badge variant="secondary">read-only</Badge>
      </div>
      <MdPreview json={builtSettings} />
    </section>
  </div>
{/if}
