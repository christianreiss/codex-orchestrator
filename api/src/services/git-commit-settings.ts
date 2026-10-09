import { z } from 'zod';
import type { SettingsService } from './settings.js';
import type { Engine } from '../util/engine.js';

export const GIT_COMMIT_SETTINGS_KEY = 'git_commit_settings';
export const gitCommitSettingsSchema = z.object({
  message_style: z.enum(['short', 'long']),
  ai_attribution: z.boolean(),
}).strict();
export type GitCommitSettings = z.infer<typeof gitCommitSettingsSchema>;
export const DEFAULT_GIT_COMMIT_SETTINGS: Readonly<GitCommitSettings> = {
  message_style: 'short',
  ai_attribution: false,
};

export async function readGitCommitSettings(settings: SettingsService): Promise<GitCommitSettings> {
  const raw = await settings.getString(GIT_COMMIT_SETTINGS_KEY);
  if (raw !== null) {
    try {
      const parsed = gitCommitSettingsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch { /* Invalid stored data uses the documented defaults. */ }
  }
  return { ...DEFAULT_GIT_COMMIT_SETTINGS };
}

export function renderGitCommitGuidance(settings: GitCommitSettings, engine: Engine): string {
  const name = { codex: 'Codex', claude: 'Claude', grok: 'Grok' }[engine];
  return `## Git commit messages

These fleet-wide preferences apply even when the Git Director or Skills are disabled.
Explicit operator instructions take precedence. These preferences do not authorize a commit or push.

${settings.message_style === 'short'
    ? '- Write one precise subject line, without an explanatory body. An enabled AI attribution trailer is still allowed.'
    : '- Write a precise subject, a blank line, then explain what changed and why. Include relevant verification results; never invent checks or results.'}
${settings.ai_attribution
    ? `- Append exactly one \`AI-Assisted-By: ${name}\` trailer after a blank line, identifying the engine performing the commit. Do not add AI co-author or Generated-by markers.`
    : '- Do not automatically add AI attribution trailers, AI co-authors, or Generated-by markers.'}
- Preserve the existing Git author and committer identity.`;
}
