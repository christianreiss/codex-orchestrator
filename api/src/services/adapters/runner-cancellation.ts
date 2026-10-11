import { ApiError } from '../../http/errors.js';

/** Keep caller cancellation and the runner deadline active through body parsing. */
export async function withRunnerCancellation<T>(
  timeoutMs: number,
  caller: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const signal = caller ? AbortSignal.any([caller, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new ApiError('Runner request timed out.', {
    status: 504, code: 'runner_timeout', type: 'api_error',
  })), timeoutMs);
  try {
    signal.throwIfAborted();
    return await run(signal);
  } finally {
    clearTimeout(timer);
  }
}
