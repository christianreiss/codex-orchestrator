/**
 * Output styles API — Claude collection artifacts under
 * /admin/claude/output-styles.
 */
import { createClaudeArtifactApi, createArtifactKeys } from "./claudeArtifacts";

export const outputStylesApi = createClaudeArtifactApi("output-styles");
export const outputStylesKeys = createArtifactKeys("output-styles");
