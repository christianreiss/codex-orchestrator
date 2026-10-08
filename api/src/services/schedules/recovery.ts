/** Base cadence is a minimum; cap exponential growth, then add positive jitter. */
export function recoveryDelaySeconds(base: number, failedAttempts: number, random = Math.random): number {
  const capped = Math.min(base * 2 ** Math.min(failedAttempts, 20), Math.max(base, 3600));
  return Math.ceil(capped * (1 + Math.max(0, Math.min(1, random())) * 0.2));
}
