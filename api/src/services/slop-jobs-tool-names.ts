/**
 * Fleet switch for slop jobs (`versions` flag, default on). Off hides the
 * slop_job_* tools and their guidance and refuses calls; the sweeper keeps
 * expiring existing jobs.
 */
export const SLOP_JOBS_ENABLED_FLAG = 'slop_jobs_enabled';
