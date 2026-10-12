import { api } from "./client";
import type { Engine } from "../constants/engines";

export type EngineSettings = Record<string, unknown>;
export interface EngineConfig {
  status: "ok" | "missing";
  sha256?: string;
  revision: string | null;
  settings?: EngineSettings | null;
  content?: string;
}
export interface EngineConfigRender {
  content: string;
  sha256: string;
  settings: EngineSettings;
}
export interface EngineConfigStore extends EngineConfigRender {
  status: "ok";
  revision: string;
  change: "created" | "updated" | "unchanged";
}
const path = (engine: Engine) => engine === "codex" ? "/admin/config" : `/admin/${engine}/config`;
export const nativeSettingsKeys = {
  config: (engine: Engine) => ["settings", "native-config", engine] as const,
};
export const nativeSettingsApi = {
  get: (engine: Engine) => api.get<EngineConfig>(path(engine)),
  render: (engine: Engine, settings: EngineSettings) => api.post<EngineConfigRender>(`${path(engine)}/render`, { settings }),
  store: (engine: Engine, settings: EngineSettings, sha256: string | null, expected_revision: string | null) => api.post<EngineConfigStore>(`${path(engine)}/store`, { settings, sha256, expected_revision }),
};
