/**
 * Commands API — Claude collection artifacts under /admin/claude/commands.
 */
import { createClaudeArtifactApi, createArtifactKeys } from "./claudeArtifacts";

export const commandsApi = createClaudeArtifactApi("commands");
export const commandsKeys = createArtifactKeys("commands");
