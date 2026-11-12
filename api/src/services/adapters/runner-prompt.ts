import { ApiError } from '../../http/errors.js';
import { ENGINE_KIMI, type Engine } from '../../util/engine.js';

/** Kimi passes the rendered prompt as argv; bound UTF-8 bytes before auth/exec. */
export const KIMI_GATEWAY_PROMPT_MAX_BYTES = 100_000;

export function assertRunnerPrompt(engine: Engine, prompt: string, system?: string | null): void {
  if (engine !== ENGINE_KIMI) return;
  if (prompt.includes('\0') || system?.includes('\0')) {
    throw new ApiError('Kimi prompts must not contain NUL characters', {
      status: 400, code: 'invalid_prompt', type: 'invalid_request_error', param: 'prompt',
    });
  }
  if (Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(system ?? '', 'utf8') > KIMI_GATEWAY_PROMPT_MAX_BYTES) {
    throw new ApiError(`Kimi gateway prompts (including system instructions) must not exceed ${KIMI_GATEWAY_PROMPT_MAX_BYTES} UTF-8 bytes`, {
      status: 413, code: 'prompt_too_large', type: 'invalid_request_error', param: 'prompt',
    });
  }
}
