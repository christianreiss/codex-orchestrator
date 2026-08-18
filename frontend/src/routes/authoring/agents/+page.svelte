<script lang="ts">
  import { createQuery, createMutation, keepPreviousData, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { agentsApi, responseVerbosityApi, type ResponseVerbosityLevelOption } from "$lib/api/agents";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { hostEngines, hostsListQuery } from "$lib/api/hosts";
  import type {
    AgentPolicyComposition,
    AgentPolicyModuleId,
    AgentPolicyProvenanceEntry,
    AgentsDocument,
    AgentsGenerationMode,
    AgentsVersion,
    AgentsVersionMeta,
  } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import { relativeTime, formatBytes } from "$lib/utils/format";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import { Switch } from "$lib/components/ui/switch";
  import { Label } from "$lib/components/ui/label";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import RenderedMarkdown from "$lib/components/authoring/RenderedMarkdown.svelte";
  import * as Select from "$lib/components/ui/select";
  import * as Dialog from "$lib/components/ui/dialog";
  import Save from "@lucide/svelte/icons/save";
  import History from "@lucide/svelte/icons/history";
  import Eye from "@lucide/svelte/icons/eye";
  import * as Card from "$lib/components/ui/card";
  import SecurityLevelsPanel from "$lib/components/settings/SecurityLevelsPanel.svelte";
  import ResponseVerbosityPanel from "$lib/components/settings/ResponseVerbosityPanel.svelte";
  import {
    agentPolicyProfilesApi,
    type AgentPolicyProfile,
    type SecurityLevelCatalog,
    type SecurityLevels,
  } from "$lib/api/agentPolicyProfiles";

  const qc = useQueryClient();

  const query = createQuery({
    queryKey: ["agents"],
    queryFn: () => agentsApi.get(),
  });
  // Posture is deliberately a separate query from the document: prose is
  // versioned per document, posture per profile.
  const profilesQuery = createQuery({
    queryKey: ["agent-policy-profiles"],
    queryFn: () => agentPolicyProfilesApi.list(),
  });
  const hosts = hostsListQuery();
  // Fleet-wide, not per-document: its own query, same reasoning as posture above.
  const verbosityQuery = createQuery({
    queryKey: ["response-verbosity"],
    queryFn: () => responseVerbosityApi.get(),
  });

  // Editor content + hydration tracking
  let content = $state("");
  let serverSha = $state<string | null>(null);
  let hydrated = $state(false);
  /**
   * The fleet master switch, and the single authority for which editor is open.
   *
   * It used to be `Boolean(data.builder_state)` — the served document decided.
   * That could not express "stop generating" at all, and gave no way back from
   * the builder to a hand-written document. `builder_state` still says how a
   * version was authored, which is what hydrates the editor; it no longer says
   * what mode the fleet is in.
   */
  let generationMode = $state<AgentsGenerationMode>("managed");
  const builderMode = $derived(generationMode !== "manual");
  /** False when the served version predates the builder, so the draft is unsaved. */
  let documentIsBuilt = $state(true);
  let enabledModules = $state<AgentPolicyModuleId[]>([]);
  let customInstructions = $state("");
  let composedDraft = $state("");
  let composedProvenance = $state<AgentPolicyProvenanceEntry[]>([]);
  let composeTimer: ReturnType<typeof setTimeout> | undefined;

  let securityCatalog = $state<SecurityLevelCatalog | null>(null);
  let defaultProfile = $state<AgentPolicyProfile | null>(null);
  let draftLevels = $state<SecurityLevels | null>(null);
  let levelsHydrated = $state(false);

  $effect(() => {
    const data = $profilesQuery.data;
    if (!data || levelsHydrated) return;
    securityCatalog = data.catalog;
    defaultProfile = data.profiles.find((p) => p.is_default) ?? null;
    draftLevels = { ...(defaultProfile?.levels ?? data.catalog.default_levels) };
    levelsHydrated = true;
  });

  let savedVerbosity = $state<number | null>(null);
  let draftVerbosity = $state<number>(0);
  let verbosityLevelOptions = $state<ResponseVerbosityLevelOption[]>([]);
  let verbosityHydrated = $state(false);

  $effect(() => {
    const data = $verbosityQuery.data;
    if (!data || verbosityHydrated) return;
    savedVerbosity = data.level;
    draftVerbosity = data.level;
    verbosityLevelOptions = data.levels ?? [];
    verbosityHydrated = true;
  });

  const verbosityDirty = $derived(savedVerbosity !== null && draftVerbosity !== savedVerbosity);

  const saveVerbosityMutation = createMutation({
    mutationFn: () => responseVerbosityApi.set(draftVerbosity),
    onSuccess: (result) => {
      savedVerbosity = result.level;
      draftVerbosity = result.level;
      toast.success("Response verbosity saved");
      void qc.invalidateQueries({ queryKey: ["response-verbosity"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to save response verbosity");
    },
  });

  const levelsDirty = $derived(
    draftLevels !== null &&
      defaultProfile !== null &&
      JSON.stringify(draftLevels) !== JSON.stringify(defaultProfile.levels),
  );

  /**
   * Claude Code refuses to start as root when the mode is bypassPermissions, so
   * those hosts are served `auto` instead. Saying so here is the difference
   * between a posture the operator selected and one their fleet is actually
   * running — otherwise the only symptom is a peer that never answers.
   *
   * Derived from the SAVED profile rather than the live slider position: this
   * describes what hosts are being served right now, not a draft.
   */
  const rootClampWarning = $derived.by(() => {
    const rootHosts = $profilesQuery.data?.root_hosts ?? [];
    if (!defaultProfile || defaultProfile.claude_permission_mode !== "bypassPermissions") return null;
    if (rootHosts.length === 0) return null;
    const named = rootHosts.slice(0, 3).join(", ");
    const rest = rootHosts.length > 3 ? ` and ${rootHosts.length - 3} more` : "";
    return `${rootHosts.length} host${rootHosts.length === 1 ? "" : "s"} run their agent as root (${named}${rest}). Claude Code refuses to start as root in bypassPermissions, so those hosts are served "auto" instead — reads and edits are auto-approved and everything else is vetted by a classifier. Run the agent as a non-root user to get the full bypass.`;
  });

  const saveLevelsMutation = createMutation({
    mutationFn: () => {
      if (!defaultProfile || !draftLevels) throw new Error("No fleet default profile to update");
      return agentPolicyProfilesApi.update(defaultProfile.id, { levels: draftLevels });
    },
    onSuccess: (result) => {
      defaultProfile = result.profile;
      draftLevels = { ...result.profile.levels };
      toast.success("Fleet posture saved");
      void qc.invalidateQueries({ queryKey: ["agent-policy-profiles"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to save posture");
    },
  });

  const draftComposition = $derived<AgentPolicyComposition>({
    schema_version: 1,
    template_id: "fleet-standard",
    template_version: 1,
    enabled_modules: enabledModules,
    custom_instructions: customInstructions,
  });

  /**
   * A document that predates the policy builder carries no module selection to
   * restore. Rather than opening an empty builder, seed it as an unsaved draft:
   * every default module on, with the hand-written body carried into custom
   * instructions so switching mode never loses what the operator wrote. Nothing
   * is stored until Save.
   */
  function hydrateBuilder(data: { builder_state?: AgentPolicyComposition | null; content?: string; builder_catalog?: AgentsDocument["builder_catalog"] }): void {
    const builder = data.builder_state ?? null;
    documentIsBuilt = builder !== null;
    const catalog = data.builder_catalog ?? $query.data?.builder_catalog;
    enabledModules = builder
      ? [...builder.enabled_modules]
      : (catalog?.modules ?? [])
          .filter((module) => module.default_enabled)
          .map((module) => module.id as AgentPolicyModuleId);
    customInstructions = builder?.custom_instructions ?? (data.content ?? "").trim();
    composedDraft = builder ? data.content ?? "" : "";
  }

  function hydrateDocument(data: AgentsDocument | undefined): void {
    if (!data) return;
    content = data.content ?? "";
    serverSha = data.sha256 ?? null;
    generationMode = data.generation_mode ?? "managed";
    hydrateBuilder(data);
    hydrated = true;
  }

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
    if (data && !hydrated) hydrateDocument(data);
  });

  const composeMutation = createMutation({
    mutationFn: (composition: AgentPolicyComposition) => agentsApi.compose(composition),
    onSuccess: (result) => {
      composedDraft = result.content;
      composedProvenance = result.provenance ?? [];
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to compose policy";
      toast.error(msg);
    },
  });

  // Never gate this on which preview the operator is looking at. `composedDraft`
  // is what `saveMutation` writes back into `content`, so a compose skipped to
  // save a request is a save that stores the wrong bytes. Composing is pure CPU
  // on the server with no host and no database work; it is not the expensive
  // half of this page.
  $effect(() => {
    if (!hydrated || !builderMode) return;
    const composition = draftComposition;
    clearTimeout(composeTimer);
    composeTimer = setTimeout(() => $composeMutation.mutate(composition), 150);
    return () => clearTimeout(composeTimer);
  });

  function setModule(id: string, enabled: boolean): void {
    const moduleId = id as AgentPolicyModuleId;
    enabledModules = enabled
      ? Array.from(new Set([...enabledModules, moduleId]))
      : enabledModules.filter((candidate) => candidate !== moduleId);
  }

  // ---- Generation mode ----
  // Applied fleet-wide the moment it is saved, with no new document version:
  // the mode changes what a stored document contributes when it is rendered,
  // not what is stored. So there is no draft state to reconcile here, and
  // flipping back restores the modules exactly.
  const generationModeMutation = createMutation({
    mutationFn: (mode: AgentsGenerationMode) => agentsApi.setGenerationMode(mode),
    onSuccess: (result) => {
      // Only after the server has it: the effective preview keys off this
      // value, and moving it first would render the new mode against the old
      // server state.
      generationMode = result.mode;
      // Leaving the builder for a hand-written document starts from what the
      // fleet is being served today, rather than from a blank page.
      if (result.mode === "manual") content = composedDraft || content;
      toast.success(
        result.mode === "off"
          ? "Generation disabled — hosts keep the fleet policy and capability guidance"
          : result.mode === "manual"
            ? "Switched to a hand-written document"
            : "Generating the fleet policy document",
      );
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to change generation mode");
    },
  });

  const GENERATION_MODES: Array<{ id: AgentsGenerationMode; label: string; hint: string }> = [
    { id: "managed", label: "Generated", hint: "Modules and custom instructions are composed into the document." },
    { id: "manual", label: "Manual", hint: "You write the document; nothing is composed." },
    { id: "off", label: "Disabled", hint: "Modules are not served. Hosts still get the fleet policy, your custom instructions, and capability guidance." },
  ];
  const generationModeHint = $derived(
    GENERATION_MODES.find((entry) => entry.id === generationMode)?.hint ?? "",
  );

  // ---- Save ----
  // `sha256` is a submit-time integrity check against the *new* content being
  // sent, not an optimistic-concurrency token — the server rejects the write
  // if the hash doesn't match the payload. Never pass the previous version's
  // hash here; that mismatches as soon as `content` has any edit in it.
  const saveMutation = createMutation({
    mutationFn: () => builderMode
      ? agentsApi.store({ composition: draftComposition })
      : agentsApi.store({ content }),
    onSuccess: (result) => {
      serverSha = result.sha256 ?? null;
      if (builderMode) content = composedDraft;
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
      // The mode is fleet state, not document state — restoring an old version
      // restores its prose, never a mode the operator did not ask for.
      hydrateBuilder(result);
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
  let renderedPreviewOpen = $state(false);
  let previewHostId = $state("");

  $effect(() => {
    if (!previewHostId && previewHosts.length > 0) previewHostId = String(previewHosts[0].id);
  });

  /**
   * The draft exactly as it will be sent, snapshotted on a debounce.
   *
   * Both the query key and the request body are read off the same snapshot, so a
   * response can never be filed under a key that describes different settings.
   */
  type RenderRequest = {
    draft: { composition: AgentPolicyComposition } | { content: string };
    levels: SecurityLevels | null;
    verbosity: number;
  };
  let renderRequest = $state<RenderRequest | null>(null);
  let renderTimer: ReturnType<typeof setTimeout> | undefined;

  // The sliders fire once per integer step with no throttle of their own, so a
  // continuous drag collapses into one trailing render rather than one per step.
  $effect(() => {
    if (!hydrated) return;
    const next: RenderRequest = {
      draft: builderMode ? { composition: draftComposition } : { content },
      levels: draftLevels,
      verbosity: draftVerbosity,
    };
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => (renderRequest = next), 300);
    return () => clearTimeout(renderTimer);
  });

  const canRenderEffective = $derived(previewHosts.length > 0 && previewHostId !== "");

  /**
   * A query rather than a mutation, because this now fires while a slider is
   * being dragged. A mutation has no cancellation and no sequence guard, so a
   * slow early response could land after a fast late one and leave the operator
   * reading a document that does not match their settings. Keying the request
   * structurally makes a stale response resolve into a stale key, where it is
   * ignored — and makes a setting the operator returns to a cache hit.
   */
  const renderedPreviewQuery = createQuery(
    reactiveOptions(() => {
      const request = renderRequest;
      const hostId = Number(previewHostId);
      return {
        // The mode is part of the key even though the server reads it from
        // fleet settings rather than from the request: with `staleTime:
        // Infinity`, a key that ignored it would leave the previous mode's
        // document sitting in the pane after the toggle moved.
        queryKey: ["agents-render", previewHostId, generationMode, JSON.stringify(request)],
        queryFn: () =>
          agentsApi.renderDraft(hostId, request!.draft, "codex", request!.levels ?? undefined, request!.verbosity),
        // Nothing is looking at this render while the pane shows the base and
        // the dialog is shut. Unlike the compose call — which feeds what Save
        // stores and must never be skipped — this one feeds pixels only.
        enabled:
          canRenderEffective &&
          request !== null &&
          (activePreviewMode === "effective" || renderedPreviewOpen),
        placeholderData: keepPreviousData,
        // A pure function of its key, so there is nothing for a refetch on
        // window focus to discover.
        staleTime: Infinity,
        // The next keystroke retries anyway; retrying each failed key three
        // times just multiplies requests against an endpoint already known to
        // be failing.
        retry: false,
      };
    }),
  );

  const renderedPreview = $derived($renderedPreviewQuery.data ?? null);
  const renderedPreviewSections = $derived(
    Object.entries(renderedPreview?.sections ?? {})
      .filter(([name]) => name !== "memory_routing")
      .map(([name, section]) => ({ name, section })),
  );

  /**
   * Reported in the pane, not as a toast.
   *
   * Every settings change mints a new query key, so a host that has stopped
   * rendering fails once per keystroke — as toasts that is a stream of them,
   * and the one place the operator is actually looking, where the document
   * should be, would still say nothing.
   */
  const renderError = $derived.by(() => {
    const err = $renderedPreviewQuery.error;
    if (!err) return null;
    return err instanceof ApiError ? err.message : "Failed to render AGENTS.md";
  });

  function refreshRenderedPreview() {
    void $renderedPreviewQuery.refetch();
  }

  function openRenderedPreview() {
    renderedPreviewOpen = true;
  }

  // ---- Preview surface ----
  // The effective document is the only render the posture sliders reach: the
  // canonical base has no policy block for them to change. So it is what the
  // pane shows by default, and the base stays one click away for the operator
  // who wants to see only what this editor actually stores.
  type PreviewMode = "effective" | "canonical";
  let previewMode = $state<PreviewMode>("effective");
  const activePreviewMode = $derived<PreviewMode>(canRenderEffective ? previewMode : "canonical");
  // The canonical pane is "what this editor stores", which in manual mode is the
  // textarea, not `composedDraft` — the compose effect does not run there, so
  // reading it would show whatever was last composed in the builder.
  const canonicalDraft = $derived(builderMode ? composedDraft : content);
  const previewContent = $derived(
    activePreviewMode === "effective" ? renderedPreview?.content ?? "" : canonicalDraft,
  );
  const previewProvenance = $derived<AgentPolicyProvenanceEntry[]>(
    activePreviewMode === "effective"
      ? renderedPreview?.provenance ?? []
      : builderMode
        ? composedProvenance
        : // A hand-written document has no per-section attribution to offer.
          [],
  );
  const axisSections = $derived<Record<string, string[]>>(
    activePreviewMode === "effective" ? renderedPreview?.axis_sections ?? {} : {},
  );

  // ---- Setting ↔ text link ----
  type ActiveSetting =
    | { kind: "module"; id: string }
    | { kind: "custom" }
    | { kind: "legacy" }
    | { kind: "axis"; id: string };
  let activeSetting = $state<ActiveSetting | null>(null);
  /** The block under the pointer in the preview, for the reverse direction. */
  let hoveredKey = $state<string | null>(null);

  const activeKeys = $derived.by(() => {
    const setting = activeSetting;
    if (!setting) return [];
    if (setting.kind === "module") return [`module:${setting.id}`];
    if (setting.kind === "custom") return ["custom_instructions"];
    if (setting.kind === "legacy") return ["legacy_document"];
    // An axis has no section of its own: it contributes sentences to whichever
    // of the mandatory sections its operations currently land in, which is a
    // function of the level and so has to come from the server.
    return (axisSections[setting.id] ?? []).map((section) => `policy:${section}`);
  });

  /** How many blocks an axis currently reaches, so the row can say so plainly. */
  function axisBlockCount(axisId: string): number {
    return (axisSections[axisId] ?? []).length;
  }

  function clearActiveSetting(): void {
    activeSetting = null;
  }

  /** Marks the control that produced the block currently under the pointer. */
  function linkClass(key: string): string {
    return hoveredKey === key ? "ring-2 ring-primary/50" : "";
  }

  /**
   * The reverse link for a mandatory section names *every* axis feeding it, not
   * a best guess at one. A single Hard Stop Lines bullet can be the joint work of
   * several axes, and at the most constrained levels every forbidden operation
   * collapses into one sentence — so "this text is yours alone" is a claim this
   * page is in no position to make.
   */
  const highlightedAxes = $derived.by(() => {
    const key = hoveredKey;
    if (key === null || !key.startsWith("policy:")) return [];
    const section = key.slice("policy:".length);
    return Object.entries(axisSections)
      .filter(([, sections]) => sections.includes(section))
      .map(([axis]) => axis);
  });

  const versions = $derived<AgentsVersionMeta[]>($query.data?.versions ?? []);
  const currentVersionId = $derived($query.data?.served_id ?? $query.data?.active_id ?? null);
</script>

<p class="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
  <span>
    This editor stores only the canonical base document — Skills, Memory, Projects, BrowserOS,
    Secrets, and Agent Messaging guidance is appended per engine and host when served as
    AGENTS.md or CLAUDE.md.
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
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div>
          <h2 class="font-semibold">Fleet policy builder</h2>
          <p class="text-xs text-muted-foreground">
            Required fleet safeguards are server-managed. Optional modules and custom instructions form the canonical base.
          </p>
        </div>
        {#if serverSha}
          <span class="font-mono text-xs text-muted-foreground" title={serverSha}>sha256: {serverSha.slice(0, 12)}…</span>
        {/if}
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
        <div class="min-w-0 space-y-0.5">
          <p class="text-sm font-medium">Generation</p>
          <p class="text-xs text-muted-foreground">
            {generationModeHint} Applies to the whole fleet as soon as you pick it — no version is saved.
          </p>
        </div>
        <div class="inline-flex rounded-md border bg-background p-0.5" role="group" aria-label="AGENTS.md generation">
          {#each GENERATION_MODES as option (option.id)}
            <button
              type="button"
              aria-pressed={generationMode === option.id}
              disabled={$generationModeMutation.isPending || generationMode === option.id}
              onclick={() => $generationModeMutation.mutate(option.id)}
              class="rounded px-2.5 py-1 text-xs transition-colors disabled:cursor-default {generationMode === option.id
                ? 'bg-primary/10 font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted'}"
            >
              {option.label}
            </button>
          {/each}
        </div>
      </div>

      <div class="grid gap-4 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
        <div class="space-y-4">
          {#if builderMode}
            <Card.Root>
              <Card.Content class="divide-y p-0">
                <div class="space-y-1 p-4">
                  <h3 class="text-sm font-semibold">Always included</h3>
                  <p class="text-xs text-muted-foreground">These guarantees cannot be disabled by the UI or API.</p>
                </div>
                {#each $query.data?.builder_catalog?.required ?? [] as item (item.id)}
                  <div class="flex items-center justify-between gap-3 p-4">
                    <div class="min-w-0">
                      <Label for={`agents-required-${item.id}`} class="text-sm font-medium">{item.label}</Label>
                      <p class="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
                    </div>
                    <Switch
                      id={`agents-required-${item.id}`}
                      checked
                      disabled
                      aria-label={`${item.label} (required)`}
                    />
                  </div>
                {/each}
              </Card.Content>
            </Card.Root>

            {#if !documentIsBuilt}
              <p class="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                The served version was hand-written, so this is an unsaved draft: every default module is
                on and the previous document is in Custom instructions. Nothing changes for hosts until you Save.
              </p>
            {/if}

            <Card.Root class={generationMode === "off" ? "opacity-60" : ""}>
              <Card.Content class="divide-y p-0">
                <div class="space-y-1 p-4">
                  <h3 class="text-sm font-semibold">Optional operating modules</h3>
                  <p class="text-xs text-muted-foreground">
                    {#if generationMode === "off"}
                      Not served while generation is disabled. Your selection is kept — switch back to
                      Generated and it returns without saving a version.
                    {:else}
                      Changes stay in this draft until you save a new version.
                    {/if}
                  </p>
                </div>
                {#each $query.data?.builder_catalog?.modules ?? [] as item (item.id)}
                  <!-- Hover and focus are wired on the row, not the Switch, so the
                       label and description are part of the target and keyboard
                       users get the same link without a second affordance. -->
                  <div
                    role="group"
                    aria-label={item.label}
                    class="flex items-center justify-between gap-3 p-4 transition-colors {linkClass(
                      `module:${item.id}`,
                    )}"
                    onmouseenter={() => (activeSetting = { kind: "module", id: item.id })}
                    onmouseleave={clearActiveSetting}
                    onfocusin={() => (activeSetting = { kind: "module", id: item.id })}
                    onfocusout={clearActiveSetting}
                  >
                    <div class="min-w-0">
                      <Label for={`agents-module-${item.id}`} class="text-sm font-medium">{item.label}</Label>
                      <p class="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
                    </div>
                    <Switch
                      id={`agents-module-${item.id}`}
                      checked={enabledModules.includes(item.id as AgentPolicyModuleId)}
                      disabled={generationMode === "off"}
                      onCheckedChange={(value) => setModule(item.id, Boolean(value))}
                      aria-label={item.label}
                    />
                  </div>
                {/each}
              </Card.Content>
            </Card.Root>

            <SecurityLevelsPanel
              catalog={securityCatalog}
              levels={draftLevels ?? securityCatalog?.default_levels ?? ({} as SecurityLevels)}
              disabled={!defaultProfile || $saveLevelsMutation.isPending}
              onChange={(next) => (draftLevels = next)}
              blockCount={activePreviewMode === "effective" ? axisBlockCount : undefined}
              highlightedAxes={highlightedAxes}
              onHighlight={(axisId) => (activeSetting = axisId === null ? null : { kind: "axis", id: axisId })}
            />
            {#if rootClampWarning}
              <div class="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                <p class="text-xs font-medium">Bypass permissions cannot reach every host</p>
                <p class="mt-1 text-xs text-muted-foreground">
                  {rootClampWarning}
                </p>
              </div>
            {/if}
            {#if levelsDirty}
              <div class="flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
                <p class="text-xs text-muted-foreground">
                  Posture is saved separately from the document.
                </p>
                <Button size="sm" onclick={() => $saveLevelsMutation.mutate()} disabled={$saveLevelsMutation.isPending}>
                  {$saveLevelsMutation.isPending ? "Saving…" : "Save posture"}
                </Button>
              </div>
            {/if}

            <ResponseVerbosityPanel
              level={draftVerbosity}
              levels={verbosityLevelOptions}
              disabled={savedVerbosity === null || $saveVerbosityMutation.isPending}
              onChange={(next) => (draftVerbosity = next)}
            />
            {#if verbosityDirty}
              <div class="flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
                <p class="text-xs text-muted-foreground">
                  Verbosity is fleet-wide and saved separately from the document.
                </p>
                <Button size="sm" onclick={() => $saveVerbosityMutation.mutate()} disabled={$saveVerbosityMutation.isPending}>
                  {$saveVerbosityMutation.isPending ? "Saving…" : "Save verbosity"}
                </Button>
              </div>
            {/if}

            <div
              role="group"
              aria-label="Custom instructions"
              class="space-y-1.5 rounded-md p-2 -m-2 transition-colors {linkClass('custom_instructions')}"
              onmouseenter={() => (activeSetting = { kind: "custom" })}
              onmouseleave={clearActiveSetting}
              onfocusin={() => (activeSetting = { kind: "custom" })}
              onfocusout={clearActiveSetting}
            >
              <Label for="agents-custom-instructions">Custom instructions</Label>
              <Textarea
                id="agents-custom-instructions"
                class="min-h-40 resize-y font-mono text-sm leading-relaxed"
                placeholder="Repository-independent fleet instructions that are not covered by a module…"
                spellcheck="false"
                bind:value={customInstructions}
              />
            </div>
          {:else}
            <!-- A hand-written document carries no per-section attribution, so
                 the whole middle links back to the one control that produced it. -->
            <div
              role="group"
              aria-label="Hand-written Markdown document"
              onmouseenter={() => (activeSetting = { kind: "legacy" })}
              onmouseleave={clearActiveSetting}
              onfocusin={() => (activeSetting = { kind: "legacy" })}
              onfocusout={clearActiveSetting}
            >
              <Card.Root class={linkClass("legacy_document")}>
                <Card.Content class="space-y-4 p-4">
                  <div class="space-y-1">
                    <h3 class="text-sm font-semibold">Hand-written Markdown document</h3>
                    <p class="text-xs text-muted-foreground">
                      Served verbatim between the mandatory fleet policy and the host capability
                      guidance, which are added either way. Saving here stores a hand-written version;
                      the module selection of the version before it stays in history.
                    </p>
                  </div>
                  <Textarea
                    id="agents-document"
                    aria-label="Hand-written Markdown document"
                    class="min-h-[60vh] resize-y font-mono text-sm leading-relaxed"
                    spellcheck="false"
                    autocomplete="off"
                    bind:value={content}
                  />
                </Card.Content>
              </Card.Root>
            </div>
          {/if}
        </div>

        <div class="min-w-0 space-y-2 xl:sticky xl:top-20 xl:self-start">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <h3 class="text-sm font-semibold">
                {activePreviewMode === "effective"
                  ? "Effective AGENTS.md"
                  : builderMode
                    ? "Generated canonical base"
                    : "Stored canonical base"}
              </h3>
              <p class="text-xs text-muted-foreground">
                {#if activePreviewMode === "effective"}
                  Updates as you change any setting. Hover a setting to light up the text it produces.
                {:else}
                  Only what this editor stores. The mandatory policy and host capabilities are added when served.
                {/if}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <div class="inline-flex rounded-md border p-0.5" role="group" aria-label="Preview scope">
                <button
                  type="button"
                  disabled={!canRenderEffective}
                  onclick={() => (previewMode = "effective")}
                  class="rounded px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 {activePreviewMode ===
                  'effective'
                    ? 'bg-primary/10 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted'}"
                >
                  Effective document
                </button>
                <button
                  type="button"
                  onclick={() => (previewMode = "canonical")}
                  class="rounded px-2 py-1 text-xs transition-colors {activePreviewMode === 'canonical'
                    ? 'bg-primary/10 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted'}"
                >
                  Canonical base
                </button>
              </div>
              {#if activePreviewMode === "effective"}
                <CopyButton value={previewContent} label="Copy document" copiedLabel="Copied" size="sm" />
              {:else}
                <CopyButton value={canonicalDraft} label="Copy base" copiedLabel="Copied" size="sm" />
              {/if}
            </div>
          </div>

          {#if !canRenderEffective}
            <p class="text-xs text-muted-foreground">
              No Codex host is enrolled, so the host-specific feature block cannot be rendered. This
              shows the canonical base only — the security posture does not appear in it.
            </p>
          {:else if activePreviewMode === "effective" && renderError}
            <p class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {renderError} — showing the last document that rendered. Your edits are not lost; they
              are just not previewed.
            </p>
          {/if}

          <article
            aria-label={activePreviewMode === "effective"
              ? "Effective AGENTS.md preview document"
              : "Generated AGENTS.md base document"}
          >
            <RenderedMarkdown
              source={previewContent}
              provenance={previewProvenance}
              {activeKeys}
              onBlockHover={(key) => (hoveredKey = key)}
              ariaLabel={activePreviewMode === "effective"
                ? "Effective AGENTS.md preview content"
                : "Generated AGENTS.md base content"}
              class="min-h-[65vh] bg-background p-6 sm:p-8"
            />
          </article>
        </div>
      </div>

      <div class="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          onclick={openRenderedPreview}
          disabled={$hosts.isPending || previewHosts.length === 0}
        >
          <Eye class="h-4 w-4" />
          Preview effective draft
        </Button>
        <Button onclick={() => $saveMutation.mutate()} disabled={$saveMutation.isPending || $composeMutation.isPending}>
          <Save class="h-4 w-4" />
          {$saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>

    <aside aria-label="Agent document controls" class="border-t pt-5">
      <p class="mb-2 text-xs text-muted-foreground">
        These do not change the draft above, so the preview does not react to them: serve mode picks
        which stored version is handed out, and retention prunes old backups.
      </p>
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
<Dialog.Root open={renderedPreviewOpen} onOpenChange={(open) => (renderedPreviewOpen = open)}>
  <Dialog.Content class="sm:max-w-5xl">
    <Dialog.Header>
      <Dialog.Title>Effective AGENTS.md draft</Dialog.Title>
      <Dialog.Description>
        This is the exact document the selected Codex host would receive if this draft were saved,
        including mandatory fleet policy and live managed feature guidance.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-3">
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-[240px] flex-1 space-y-1.5">
          <label for="agents-preview-host" class="text-xs font-medium">Codex host</label>
          <!-- The host is part of the query key, so switching it re-renders in
               place rather than blanking the document until a manual refresh. -->
          <Select.Root type="single" value={previewHostId} onValueChange={(value) => (previewHostId = value ?? "")}>
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
        <Button onclick={refreshRenderedPreview} disabled={$renderedPreviewQuery.isFetching || !previewHostId}>
          <Eye class="h-4 w-4" />
          {$renderedPreviewQuery.isFetching ? "Rendering…" : "Refresh"}
        </Button>
      </div>

      {#if $renderedPreviewQuery.isPending}
        <p class="text-sm text-muted-foreground">Rendering the host-specific document…</p>
      {:else if renderedPreview?.status === "missing"}
        <p class="text-sm text-muted-foreground">No AGENTS.md document is currently configured for this host.</p>
      {:else if renderedPreview}
        <div class="flex flex-wrap items-center justify-between gap-2">
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
          <CopyButton
            value={renderedPreview.content ?? ""}
            label="Copy document"
            copiedLabel="Copied"
            size="sm"
            toastMessage="Rendered AGENTS.md copied"
          />
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
          <article aria-label="Effective AGENTS.md draft document">
          <RenderedMarkdown
            source={renderedPreview.content ?? ""}
            ariaLabel="Rendered AGENTS.md content"
            class="min-h-[55vh] bg-background p-6 sm:p-8"
          />
        </article>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (renderedPreviewOpen = false)}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
