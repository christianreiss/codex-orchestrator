/**
 * Subagents API — Claude collection artifacts under /admin/claude/subagents.
 */
import { createClaudeArtifactApi, createArtifactKeys } from "./claudeArtifacts";

export const subagentsApi = createClaudeArtifactApi("subagents");
export const subagentsKeys = createArtifactKeys("subagents");
