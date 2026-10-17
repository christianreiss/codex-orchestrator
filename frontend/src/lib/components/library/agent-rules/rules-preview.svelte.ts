/**
 * The live preview of the Agent rules draft, and the link between a setting and
 * the text it produces. The effective document is rendered by the server (the
 * same renderer the wrapper uses), keyed structurally on the draft so a slow
 * stale response can never overwrite a newer one.
 */
import { fromStore } from "svelte/store";
import { createQuery, keepPreviousData } from "@tanstack/svelte-query";
import { agentsApi } from "$lib/api/agents";
import { ApiError } from "$lib/api/client";
import { hostEngines, hostsListQuery } from "$lib/api/hosts";
import type { SecurityLevels } from "$lib/api/agentPolicyProfiles";
import type { AgentPolicyComposition, AgentPolicyProvenanceEntry } from "$lib/api/types";
import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
import type { RulesDocState } from "./rules-doc.svelte";
import type { RulesPostureState } from "./rules-posture.svelte";

type Engine = "codex" | "claude" | "grok";
const ENGINES: Engine[] = ["codex", "claude", "grok"];
export type PreviewMode = "effective" | "canonical";
export type ActiveSetting =
  | { kind: "module"; id: string }
  | { kind: "custom" }
  | { kind: "legacy" }
  | { kind: "axis"; id: string };

/** The draft exactly as it will be sent; query key and request body come off one snapshot. */
type RenderRequest = {
  draft: { composition: AgentPolicyComposition } | { content: string };
  levels: SecurityLevels | null;
  verbosity: number;
};

/**
 * A query rather than a mutation: it fires while a slider is dragged, and a
 * mutation has no cancellation or sequence guard. Keying structurally makes a
 * stale response resolve into a stale key, and a setting you return to a hit.
 */
function createRenderStore(self: RulesPreviewState) {
  return fromStore(
    createQuery(
      reactiveOptions(() => {
        const request = self.renderRequest;
        const hostId = Number(self.previewHostId);
        return {
          // The mode is part of the key even though the server reads it from
          // fleet settings: with `staleTime: Infinity` a key that ignored it
          // would leave the previous mode's document in the pane.
          queryKey: ["agents-render", self.previewHostId, self.previewEngine, self.doc.generationMode, JSON.stringify(request)],
          queryFn: () => agentsApi.renderDraft(hostId, request!.draft, self.previewEngine, request!.levels ?? undefined, request!.verbosity),
          // This feeds pixels only (unlike compose, which feeds what Save stores).
          enabled: self.canRenderEffective && request !== null && (self.activePreviewMode === "effective" || self.renderedPreviewOpen),
          placeholderData: keepPreviousData,
          staleTime: Infinity,
          // The next keystroke retries anyway; retrying each failed key would
          // just multiply requests against an endpoint already known to fail.
          retry: false,
        };
      }),
    ),
  );
}

export class RulesPreviewState {
  doc!: RulesDocState;
  posture!: RulesPostureState;
  private hostsStore = fromStore(hostsListQuery());

  previewHostId = $state("");
  previewEngine = $state<Engine>("codex");
  renderedPreviewOpen = $state(false);
  previewMode = $state<PreviewMode>("effective");
  renderRequest = $state<RenderRequest | null>(null);

  // ---- setting <-> text link ----
  activeSetting = $state<ActiveSetting | null>(null);
  /** The block under the pointer in the preview, for the reverse direction. */
  hoveredKey = $state<string | null>(null);

  previewHosts = $derived(
    (this.hostsStore.current.data?.hosts ?? []).filter((host) => hostEngines(host).some((engine) => ENGINES.includes(engine as Engine))),
  );
  hostsPending = $derived(this.hostsStore.current.isPending);
  previewHostEngines = $derived.by<Engine[]>(() => {
    const host = this.previewHosts.find((candidate) => String(candidate.id) === this.previewHostId);
    return host ? (hostEngines(host).filter((engine) => ENGINES.includes(engine as Engine)) as Engine[]) : [];
  });
  canRenderEffective = $derived(this.previewHosts.length > 0 && this.previewHostId !== "");
  activePreviewMode = $derived<PreviewMode>(this.canRenderEffective ? this.previewMode : "canonical");

  private renderStore!: ReturnType<typeof createRenderStore>;
  get renderQuery() {
    return this.renderStore.current;
  }
  rendered = $derived(this.renderStore.current.data ?? null);
  renderedSections = $derived(
    Object.entries(this.rendered?.sections ?? {})
      .filter(([name]) => name !== "memory_routing")
      .map(([name, section]) => ({ name, section })),
  );
  /** Reported in the pane, not as a toast: a failing host fails once per keystroke. */
  renderError = $derived.by(() => {
    const err = this.renderStore.current.error;
    if (!err) return null;
    return err instanceof ApiError ? err.message : "Failed to render AGENTS.md";
  });

  previewContent = $derived(this.activePreviewMode === "effective" ? this.rendered?.content ?? "" : this.doc.canonicalDraft);
  previewProvenance = $derived<AgentPolicyProvenanceEntry[]>(
    this.activePreviewMode === "effective"
      ? this.rendered?.provenance ?? []
      : this.doc.builderMode
        ? this.doc.composedProvenance
        : // A hand-written document has no per-section attribution to offer.
          [],
  );
  axisSections = $derived<Record<string, string[]>>(this.activePreviewMode === "effective" ? this.rendered?.axis_sections ?? {} : {});

  activeKeys = $derived.by(() => {
    const setting = this.activeSetting;
    if (!setting) return [];
    if (setting.kind === "module") return [`module:${setting.id}`];
    if (setting.kind === "custom") return ["custom_instructions"];
    if (setting.kind === "legacy") return ["legacy_document"];
    // An axis has no section of its own: it contributes sentences to whichever
    // mandatory sections its operations currently land in (a function of level).
    return (this.axisSections[setting.id] ?? []).map((section) => `policy:${section}`);
  });

  /**
   * The reverse link for a mandatory section names EVERY axis feeding it: one
   * Hard Stop Lines bullet can be the joint work of several axes.
   */
  highlightedAxes = $derived.by(() => {
    const key = this.hoveredKey;
    if (key === null || !key.startsWith("policy:")) return [];
    const section = key.slice("policy:".length);
    return Object.entries(this.axisSections)
      .filter(([, sections]) => sections.includes(section))
      .map(([axis]) => axis);
  });

  constructor(doc: RulesDocState, posture: RulesPostureState) {
    this.doc = doc;
    this.posture = posture;
    this.renderStore = createRenderStore(this);
    $effect(() => {
      if (!this.previewHostId && this.previewHosts.length > 0) this.previewHostId = String(this.previewHosts[0]!.id);
    });
    $effect(() => {
      const engines = this.previewHostEngines;
      if (engines.length && !engines.includes(this.previewEngine)) this.previewEngine = engines[0]!;
    });
    // The sliders fire once per integer step with no throttle of their own, so a
    // continuous drag collapses into one trailing render rather than one per step.
    $effect(() => {
      if (!this.doc.hydrated) return;
      const next: RenderRequest = {
        draft: this.doc.builderMode ? { composition: this.doc.draftComposition } : { content: this.doc.content },
        levels: this.posture.draftLevels,
        verbosity: this.posture.draftVerbosity,
      };
      const timer = setTimeout(() => (this.renderRequest = next), 300);
      return () => clearTimeout(timer);
    });
  }

  axisBlockCount = (axisId: string): number => (this.axisSections[axisId] ?? []).length;
  clearActiveSetting = (): void => {
    this.activeSetting = null;
  };
  /** Marks the control that produced the block currently under the pointer. */
  linkClass = (key: string): string => (this.hoveredKey === key ? "ring-2 ring-primary/50" : "");
  setActive(setting: ActiveSetting | null): void {
    this.activeSetting = setting;
  }
}
