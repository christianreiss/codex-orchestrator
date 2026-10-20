import { createHash } from 'node:crypto';

/** MySQL identifiers are limited to 64 characters, including generated FK names. */
export function normalizeBaselineSql(source: string): string {
  return source.replaceAll('--> statement-breakpoint', '').replace(
    /(\bCONSTRAINT\s+|\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+)`([^`]+)`/gi,
    (_match, prefix: string, name: string) => {
      const characters = Array.from(name);
      if (characters.length <= 64) return `${prefix}\`${name}\``;
      const digest = createHash('sha256').update(name).digest('hex').slice(0, 16);
      return `${prefix}\`${characters.slice(0, 47).join('')}_${digest}\``;
    },
  );
}
