import { z } from 'zod';
import { ValidationError } from '../../http/errors.js';
export const severitySchema = z.enum(['important', 'critical', 'blocker']);
export const answerModeSchema = z.enum(['buttons', 'text', 'both']);
export const choiceSchema = z
  .object({ label: z.string().trim().min(1).max(500), value: z.string().trim().min(1).max(500) })
  .strict();
export const chatMetadataSchema = z
  .object({
    attachments: z.array(z.string().uuid()).max(10).refine(ids => new Set(ids).size === ids.length, 'Attachment IDs must be unique').optional(),
    reply_to: z.number().int().positive().optional(),
    choice_value: z.string().max(500).optional(),
  })
  .strict();
export type ChatMetadata = z.infer<typeof chatMetadataSchema>;
export function promptChoices(input: Record<string, unknown>) {
  const choices =
    input.choices === undefined
      ? Array.isArray(input.options)
        ? input.options.slice(0, 20).map((value) => ({ label: String(value), value: String(value) }))
        : []
      : z.array(choiceSchema).max(20).parse(input.choices);
  const mode = answerModeSchema.parse(input.answer_mode ?? 'both');
  if (mode === 'buttons' && !choices.length) throw new ValidationError('Button answers require choices');
  if (new Set(choices.map((c) => c.value)).size !== choices.length)
    throw new ValidationError('Choice values must be unique');
  return { choices, mode };
}
export function validAnswer(
  mode: string,
  choices: Array<{ label: string; value: string }>,
  text: string,
  choice?: string,
) {
  if (choice !== undefined)
    return mode !== 'text' && choices.some((c) => c.value === choice) && text === choice;
  return mode !== 'buttons';
}
export const attachmentCreateSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(255),
    mime_type: z
      .string()
      .regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/)
      .max(127)
      .default('application/octet-stream'),
    size_bytes: z.number().int().min(1),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export const chunkSchema = z
  .object({ offset: z.number().int().nonnegative(), content_b64: z.string().max(6 * 1024 * 1024) })
  .strict();
export const CHAT_LIMITS = {
  max_file_bytes: 100 * 1024 * 1024,
  max_total_bytes: 250 * 1024 * 1024,
  max_attachments: 10,
  max_chunk_bytes: 4 * 1024 * 1024,
  max_media_seconds: 900,
};
