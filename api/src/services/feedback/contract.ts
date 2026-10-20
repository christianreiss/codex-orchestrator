import { z } from 'zod';

export const FEEDBACK_MODE_KEY = 'feedback_mode';
export const FEEDBACK_CONFIG_KEY = 'feedback_user_settings';
export const FEEDBACK_TOKEN_KEY = 'feedback_github_token';
export const UPSTREAM_REPOSITORY = 'christianreiss/codex-orchestrator';
export const configSchema = z.object({
  mode: z.enum(['source_developer', 'user']),
  auto_publish: z.boolean(),
  runner_enabled: z.boolean(),
  engine: z.enum(['codex', 'claude', 'grok']).nullable(),
  model: z.string().trim().min(1).max(200).nullable(),
}).strict().refine((c) => !c.runner_enabled || (c.engine !== null && c.model !== null), {
  message: 'Select an engine and model before enabling the feedback runner',
});
export type FeedbackConfig = z.infer<typeof configSchema>;
export const versionStates = ['unknown', 'old_version', 'recent'] as const;
export const reviewStates = ['pending', 'needs_retest', 'new', 'known', 'fixed', 'discarded', 'unclear'] as const;
export const deliveryStates = ['local', 'pending', 'sent', 'uncertain', 'failed'] as const;

/** Only public, read-only product endpoints. No caller-controlled URL or headers. */
export const probeSchema = z.object({
  endpoint: z.enum(['health', 'versions']),
  pointer: z.string().regex(/^(\/[A-Za-z0-9_~-]+)*$/).max(300),
  equals: z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]),
}).strict();
export type FeedbackProbe = z.infer<typeof probeSchema>;
export interface ProbeObservation {
  passed: boolean;
  commit: string | null;
  at: string;
  status: number;
  /** Values may contain installation details; they never enter public text. */
  actual?: unknown;
}
export const verdictSchema = z.object({
  verdict: z.enum(['new', 'known', 'fixed', 'unclear']),
  reason: z.string().min(1).max(2000),
  issue_number: z.number().int().positive().nullable(),
  evidence_urls: z.array(z.string().url().max(1000)).max(12),
  public_title: z.string().trim().min(1).max(255),
  public_body: z.string().trim().min(1).max(16000),
  comment: z.string().trim().min(1).max(8000).nullable(),
}).strict();
export type FeedbackVerdict = z.infer<typeof verdictSchema>;

export interface PipelineEvidence {
  probe?: FeedbackProbe;
  baseline?: ProbeObservation;
  retest?: ProbeObservation;
  verdict?: FeedbackVerdict;
  report_digest?: string;
  config_revision?: string;
  search_issue_numbers?: number[];
  checked_at?: string;
  attempted_body?: string;
  attempted_title?: string;
  action?: 'issue' | 'comment';
  marker?: string;
}
