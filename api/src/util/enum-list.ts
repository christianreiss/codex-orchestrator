import { z } from 'zod';

/** Protocol sets accept repeated entries. Keep large lists bounded during validation. */
export function enumList<const T extends readonly [string, ...string[]]>(values: T) {
  const allowed: ReadonlySet<unknown> = new Set(values);
  return z.preprocess((input) => {
    if (!Array.isArray(input) || input.length <= allowed.size) return input;
    const seen = new Set<string>();
    for (const item of input) {
      if (typeof item !== 'string' || !allowed.has(item)) return [...seen, item];
      seen.add(item);
    }
    return [...seen];
  }, z.array(z.enum(values)));
}
