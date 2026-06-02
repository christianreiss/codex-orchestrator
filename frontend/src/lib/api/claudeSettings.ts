/**
 * Claude fleet settings API — settings.json sub-blocks managed by the fleet.
 *
 *   GET  /admin/claude/config         → ClaudeConfigResponse
 *   POST /admin/claude/config/store   → ClaudeConfigStoreResult
 */
import { api } from "./client";
import type {
  ClaudeConfigResponse,
  ClaudeConfigSettings,
  ClaudeConfigStoreResult,
} from "./types";

export const claudeSettingsApi = {
  get(): Promise<ClaudeConfigResponse> {
    return api.get<ClaudeConfigResponse>("/admin/claude/config");
  },
  store(payload: { settings: ClaudeConfigSettings; sha256?: string | null }): Promise<ClaudeConfigStoreResult> {
    return api.post<ClaudeConfigStoreResult>("/admin/claude/config/store", payload);
  },
};

export const claudeSettingsKeys = {
  all: ["claude-settings"] as const,
  config: () => ["claude-settings", "config"] as const,
};
