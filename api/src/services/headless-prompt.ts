import { ValidationError } from '../http/errors.js';

export const KIMI_PROMPT_MAX_BYTES = 100_000;

/** Kimi accepts prompts only as argv; JS character counts do not bound execve bytes. */
export function assertHeadlessPrompt(engine: string, prompt: string): void {
  if (engine === 'kimi' && Buffer.byteLength(prompt, 'utf8') > KIMI_PROMPT_MAX_BYTES) {
    throw new ValidationError('Kimi prompt exceeds 100000 UTF-8 bytes', { param: 'prompt' });
  }
}
