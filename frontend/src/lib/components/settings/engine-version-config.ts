import type { CodexVersionsCheckResult, CodexVersionsSummary } from "$lib/api/types";
import type { VersionEngine } from "$lib/api/settings";

/**
 * What differs between the four engine version sections: copy, example, and
 * where `POST /admin/versions/check` reports each engine. Grok and Kimi carry a
 * native floor (`minVersion`): their fleet target resolves through the lock and
 * is labelled and described differently from Codex and Claude, which only follow
 * `latest` or an exact pin.
 */
export interface EngineVersionConfig {
  /** Name used in toasts and labels. */
  label: string;
  /** What "latest" means in the section description. */
  release: string;
  /** Placeholder for the exact-version input and the validation toast. */
  example: string;
  /** Native floor, when the engine has one. */
  minVersion?: string;
  summary: (data: CodexVersionsCheckResult) => CodexVersionsSummary | null | undefined;
  available: (data: CodexVersionsCheckResult) => { version?: string | null } | null | undefined;
}

export const ENGINE_VERSION_CONFIG: Record<VersionEngine, EngineVersionConfig> = {
  codex: {
    label: "Codex",
    release: "Codex",
    example: "0.125.0",
    summary: (data) => data.versions,
    available: (data) => data.available_client,
  },
  claude: {
    label: "Claude",
    release: "Claude Code",
    example: "2.1.170",
    summary: (data) => data.claude_versions,
    available: (data) => data.claude_available_client,
  },
  grok: {
    label: "Grok",
    release: "Grok Build",
    example: "1.0.50",
    minVersion: "1.0.50",
    summary: (data) => data.grok_versions,
    available: (data) => data.grok_available_client,
  },
  kimi: {
    label: "Kimi Code",
    release: "Kimi Code",
    example: "2.5.3",
    minVersion: "2.5.3",
    summary: (data) => data.kimi_versions,
    available: (data) => data.kimi_available_client,
  },
};
