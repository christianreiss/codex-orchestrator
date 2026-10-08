import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

export const scheduleInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    target: z.string().regex(/^agent:[0-9a-f-]{36}$/i),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(30_000)
      .refine((v) => Buffer.byteLength(v, 'utf8') <= 30_000, 'Prompt exceeds 30000 UTF-8 bytes'),
    kind: z.enum(['once', 'cron', 'interval']),
    at: z.string().datetime({ offset: true }).nullable().optional(),
    cron: z.string().trim().max(120).nullable().optional(),
    interval_minutes: z.number().int().min(1).max(525_600).nullable().optional(),
    timezone: z.string().max(100).default('Europe/Berlin'),
    enabled: z.boolean().default(true),
    persistent: z.boolean().default(false),
    progress_timeout_seconds: z.number().int().min(60).max(604_800).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const error = (message: string) => ctx.addIssue({ code: 'custom', message });
    try {
      new Intl.DateTimeFormat('en', { timeZone: v.timezone });
    } catch {
      error('Invalid IANA timezone');
    }
    if (
      v.kind === 'once'
        ? !v.at || !!v.cron || !!v.interval_minutes
        : v.kind === 'cron'
          ? !v.cron || !!v.at || !!v.interval_minutes
          : !v.interval_minutes || !!v.at || !!v.cron
    )
      error('Supply only the timing field for the selected kind');
    if (v.kind === 'cron' && v.cron) {
      try {
        if (v.cron.split(/\s+/).length !== 5) throw new Error();
        CronExpressionParser.parse(v.cron, { tz: v.timezone });
      } catch {
        error('Invalid five-field cron expression');
      }
    }
    if (v.persistent && !v.progress_timeout_seconds)
      error('Persistent recovery requires an explicit progress timeout');
    if (!v.persistent && v.progress_timeout_seconds) error('Progress timeout requires persistent recovery');
  });
export type ScheduleInput = z.infer<typeof scheduleInput>;

// Calculate from NOW, not the previous deadline: missed ticks collapse into one.
export function nextOccurrence(
  input: Pick<ScheduleInput, 'kind' | 'at' | 'cron' | 'interval_minutes' | 'timezone'>,
  now: Date,
): string | null {
  if (input.kind === 'once') return null;
  if (input.kind === 'interval')
    return new Date(now.getTime() + input.interval_minutes! * 60_000).toISOString();
  let expression = CronExpressionParser.parse(input.cron!, { currentDate: now, tz: input.timezone });
  for (let i = 0; i < 4; i++) {
    const candidate = expression.next().toDate();
    // Skip cron-parser spring-forward shifts outside the requested hour set.
    // Its fall-back parser already emits the repeated local hour once.
    const localHour = Number(
      new Intl.DateTimeFormat('en', { timeZone: input.timezone, hour: 'numeric', hourCycle: 'h23' }).format(
        candidate,
      ),
    );
    if (expression.fields.hour.values.includes(localHour as never)) return candidate.toISOString();
    expression = CronExpressionParser.parse(input.cron!, { currentDate: candidate, tz: input.timezone });
  }
  throw new Error('Cannot calculate next cron occurrence');
}
