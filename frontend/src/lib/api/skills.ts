/**
 * Skills API — typed builders for /admin/skills/* endpoints.
 *
 * Used by the Authoring feature.
 */
import { api } from "./client";
import type { Skill, SkillDetail, SkillListResponse, SkillStoreResult, SkillGenerateResult, SkillAssistResult } from "./types";

export const skillsApi = {
  list(): Promise<SkillListResponse> {
    return api.get<SkillListResponse>("/admin/skills");
  },
  get(slug: string): Promise<SkillDetail> {
    return api.get<SkillDetail>(`/admin/skills/${encodeURIComponent(slug)}`);
  },
  store(payload: {
    slug: string;
    manifest: string;
    display_name?: string | null;
    description?: string | null;
    sha256?: string | null;
  }): Promise<SkillStoreResult> {
    return api.post<SkillStoreResult>("/admin/skills/store", payload);
  },
  generate(payload: { prompt: string; slug_hint?: string | null }): Promise<SkillGenerateResult> {
    return api.post<SkillGenerateResult>("/admin/skills/generate", payload);
  },
  assist(payload: {
    mode: "new" | "edit";
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    skill?: { slug?: string; manifest?: string; display_name?: string | null; description?: string | null } | null;
  }): Promise<SkillAssistResult> {
    return api.post<SkillAssistResult>("/admin/skills/assist", payload);
  },
  delete(slug: string): Promise<{ deleted: string }> {
    return api.delete<{ deleted: string }>(`/admin/skills/${encodeURIComponent(slug)}`);
  },
};

export type { Skill, SkillDetail, SkillListResponse, SkillStoreResult, SkillGenerateResult, SkillAssistResult };
