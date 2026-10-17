/**
 * The Agent rules draft: the stored document, the module selection and custom
 * instructions, the composed Markdown, and the three things that change them
 * (compose, save, generation mode). Construct during component initialisation.
 */
import { fromStore } from "svelte/store";
import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
import { toast } from "svelte-sonner";
import { agentsApi } from "$lib/api/agents";
import { ApiError } from "$lib/api/client";
import type {
  AgentPolicyComposition,
  AgentPolicyModuleId,
  AgentPolicyProvenanceEntry,
  AgentsDocument,
  AgentsGenerationMode,
} from "$lib/api/types";

export const GENERATION_MODES: Array<{ id: AgentsGenerationMode; label: string; hint: string }> = [
  { id: "managed", label: "Generated", hint: "Modules and custom instructions are composed into the document." },
  { id: "manual", label: "Manual", hint: "You write the document; nothing is composed." },
  { id: "off", label: "Disabled", hint: "Modules are not served. Hosts still get the fleet policy, your custom instructions, and capability guidance." },
];

type Hydratable = {
  builder_state?: AgentPolicyComposition | null;
  content?: string;
  builder_catalog?: AgentsDocument["builder_catalog"];
};

export class RulesDocState {
  private qc = useQueryClient();
  private store = fromStore(createQuery({ queryKey: ["agents"], queryFn: () => agentsApi.get() }));
  get query() {
    return this.store.current;
  }
  get data(): AgentsDocument | undefined {
    return this.store.current.data;
  }

  content = $state("");
  serverSha = $state<string | null>(null);
  hydrated = $state(false);
  /**
   * The fleet master switch, and the single authority for which editor is
   * open. `builder_state` says how a version was authored (it hydrates the
   * editor); it does not say what mode the fleet is in.
   */
  generationMode = $state<AgentsGenerationMode>("managed");
  builderMode = $derived(this.generationMode !== "manual");
  /** False when the served version predates the builder, so the draft is unsaved. */
  documentIsBuilt = $state(true);
  enabledModules = $state<AgentPolicyModuleId[]>([]);
  customInstructions = $state("");
  composedDraft = $state("");
  composedProvenance = $state<AgentPolicyProvenanceEntry[]>([]);

  draftComposition = $derived<AgentPolicyComposition>({
    schema_version: 1,
    template_id: "fleet-standard",
    template_version: 1,
    enabled_modules: this.enabledModules,
    custom_instructions: this.customInstructions,
  });
  /** What the "canonical base" pane shows: in manual mode, the textarea itself. */
  canonicalDraft = $derived(this.builderMode ? this.composedDraft : this.content);
  generationModeHint = $derived(GENERATION_MODES.find((entry) => entry.id === this.generationMode)?.hint ?? "");

  private composeStore = fromStore(
    createMutation({
      mutationFn: (composition: AgentPolicyComposition) => agentsApi.compose(composition),
      onSuccess: (result) => {
        this.composedDraft = result.content;
        this.composedProvenance = result.provenance ?? [];
      },
      onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to compose policy"),
    }),
  );
  get composing() {
    return this.composeStore.current.isPending;
  }

  // `sha256` is a submit-time integrity check against the NEW content being
  // sent, not an optimistic-concurrency token. Never pass the previous hash.
  private saveStore = fromStore(
    createMutation({
      mutationFn: () =>
        this.builderMode ? agentsApi.store({ composition: this.draftComposition }) : agentsApi.store({ content: this.content }),
      onSuccess: (result) => {
        this.serverSha = result.sha256 ?? null;
        if (this.builderMode) this.content = this.composedDraft;
        toast.success(result.status === "unchanged" ? "No changes to save" : `Stored version #${result.version_id ?? "?"}`);
        void this.qc.invalidateQueries({ queryKey: ["agents"] });
      },
      onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to save"),
    }),
  );
  get saving() {
    return this.saveStore.current.isPending;
  }
  save() {
    this.saveStore.current.mutate();
  }

  // Applied fleet-wide the moment it is saved, with no new document version:
  // the mode changes what a stored document contributes when rendered, not what
  // is stored. Flipping back restores the modules exactly.
  private modeStore = fromStore(
    createMutation({
      mutationFn: (mode: AgentsGenerationMode) => agentsApi.setGenerationMode(mode),
      onSuccess: (result) => {
        // Only after the server has it: the effective preview keys off this value.
        this.generationMode = result.mode;
        // Leaving the builder for a hand-written document starts from what the fleet is served today.
        if (result.mode === "manual") this.content = this.composedDraft || this.content;
        toast.success(
          result.mode === "off"
            ? "Generation disabled — hosts keep the fleet policy and capability guidance"
            : result.mode === "manual"
              ? "Switched to a hand-written document"
              : "Generating the fleet policy document",
        );
        void this.qc.invalidateQueries({ queryKey: ["agents"] });
      },
      onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to change generation mode"),
    }),
  );
  get modePending() {
    return this.modeStore.current.isPending;
  }
  setGenerationMode(mode: AgentsGenerationMode) {
    this.modeStore.current.mutate(mode);
  }

  constructor() {
    $effect(() => {
      const data = this.data;
      if (data && !this.hydrated) this.hydrateDocument(data);
    });

    // Never gate this on which preview is showing. `composedDraft` is what Save
    // writes back into `content`; a compose skipped to save a request is a save
    // that stores the wrong bytes. Composing is pure CPU on the server.
    $effect(() => {
      if (!this.hydrated || !this.builderMode) return;
      const composition = this.draftComposition;
      const timer = setTimeout(() => this.composeStore.current.mutate(composition), 150);
      return () => clearTimeout(timer);
    });
  }

  /**
   * A document that predates the policy builder has no module selection to
   * restore: seed an unsaved draft with every default module on and the
   * hand-written body carried into custom instructions. Nothing is stored
   * until Save.
   */
  hydrateBuilder(data: Hydratable): void {
    const builder = data.builder_state ?? null;
    this.documentIsBuilt = builder !== null;
    const catalog = data.builder_catalog ?? this.data?.builder_catalog;
    this.enabledModules = builder
      ? [...builder.enabled_modules]
      : (catalog?.modules ?? []).filter((module) => module.default_enabled).map((module) => module.id as AgentPolicyModuleId);
    this.customInstructions = builder?.custom_instructions ?? (data.content ?? "").trim();
    this.composedDraft = builder ? data.content ?? "" : "";
  }

  hydrateDocument(data: AgentsDocument): void {
    this.content = data.content ?? "";
    this.serverSha = data.sha256 ?? null;
    this.generationMode = data.generation_mode ?? "managed";
    this.hydrateBuilder(data);
    this.hydrated = true;
  }

  setModule(id: string, enabled: boolean): void {
    const moduleId = id as AgentPolicyModuleId;
    this.enabledModules = enabled
      ? Array.from(new Set([...this.enabledModules, moduleId]))
      : this.enabledModules.filter((candidate) => candidate !== moduleId);
  }
}
