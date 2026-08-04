/**
 * Agents API — typed builders for /admin/agents/* endpoints.
 *
 * Backs the AGENTS.md editor with version history + serve mode.
 */
import { api } from "./client";
import type {
  AgentPolicyComposition,
  AgentPolicyComposeResult,
  AgentsDocument,
  AgentsGenerationMode,
  AgentsRenderedDocument,
  AgentsVersion,
  AgentsStoreResult,
} from "./types";

export const agentsApi = {
  get(): Promise<AgentsDocument> {
    return api.get<AgentsDocument>("/admin/agents");
  },
  getVersion(id: number): Promise<AgentsVersion> {
    return api.get<AgentsVersion>(`/admin/agents/versions/${id}`);
  },
  render(hostId: number, engine: "codex" | "claude" = "codex"): Promise<AgentsRenderedDocument> {
    return api.get<AgentsRenderedDocument>(
      `/admin/agents/render?host_id=${encodeURIComponent(String(hostId))}&engine=${encodeURIComponent(engine)}`,
    );
  },
  compose(composition: AgentPolicyComposition): Promise<AgentPolicyComposeResult> {
    return api.post<AgentPolicyComposeResult>("/admin/agents/compose", { composition });
  },
  /**
   * `securityLevels` carries the operator's DRAFT posture. Without it the
   * preview renders at the saved posture while sliders are being dragged, which
   * is the worst possible failure for a preview.
   */
  renderDraft(
    hostId: number,
    draft: { composition: AgentPolicyComposition } | { content: string },
    engine: "codex" | "claude" = "codex",
    securityLevels?: Record<string, number>,
  ): Promise<AgentsRenderedDocument> {
    return api.post<AgentsRenderedDocument>("/admin/agents/render", {
      host_id: hostId,
      engine,
      ...draft,
      ...(securityLevels === undefined ? {} : { security_levels: securityLevels }),
    });
  },
  store(payload: { content: string; sha256?: string | null } | { composition: AgentPolicyComposition }): Promise<AgentsStoreResult> {
    return api.post<AgentsStoreResult>("/admin/agents/store", payload);
  },
  serve(payload: { mode: "latest" | "locked"; version_id?: number | null }): Promise<AgentsDocument> {
    return api.post<AgentsDocument>("/admin/agents/serve", payload);
  },
  revert(payload: { version_id: number }): Promise<AgentsDocument> {
    return api.post<AgentsDocument>("/admin/agents/revert", payload);
  },
  retention(payload: { backup_limit: number }): Promise<AgentsDocument> {
    return api.post<AgentsDocument>("/admin/agents/retention", payload);
  },
  deleteVersion(id: number): Promise<{ deleted_id?: number } & Record<string, unknown>> {
    return api.delete(`/admin/agents/versions/${id}`);
  },
  /**
   * The fleet generation mode. It lives here rather than in `settings.ts`
   * because it is read back off `/admin/agents` — the editor has to know which
   * shape to open in before it can hydrate, so a separate read query would mean
   * rendering the wrong editor first.
   */
  setGenerationMode(mode: AgentsGenerationMode): Promise<{ mode: AgentsGenerationMode }> {
    return api.post<{ mode: AgentsGenerationMode }>("/admin/agents-generation-mode", { mode });
  },
};

export type { AgentsDocument, AgentsGenerationMode, AgentsRenderedDocument, AgentsVersion, AgentsStoreResult };
