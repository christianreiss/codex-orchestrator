/**
 * The slop job MCP tool names for consumers outside the registry (the Claude
 * permission allowlist). The registry spells them as literals so the docs
 * catalog test sees them; see agent-transfers-tool-names.ts for why.
 */
export const SLOP_JOB_TOOL_NAMES = {
  create: 'slop_job_create',
  put: 'slop_job_put',
  describe: 'slop_job_describe',
  run: 'slop_job_run',
  get: 'slop_job_get',
  result: 'slop_job_result',
  diff: 'slop_job_diff',
  list: 'slop_job_list',
  close: 'slop_job_close',
} as const;

export const SLOP_JOB_TOOLS: readonly string[] = Object.values(SLOP_JOB_TOOL_NAMES);
