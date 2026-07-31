/**
 * Recognise MySQL 1191, "Can't find FULLTEXT index matching the column list".
 *
 * Every `MATCH ... AGAINST` path in this codebase needs this, because the
 * FULLTEXT indexes are created by the migration files and `drizzle-kit push`
 * cannot express FULLTEXT at all — so a database built that way has the tables
 * but not the indexes, and every search throws instead of returning nothing.
 * Callers catch this and fall back to a bounded substring scan, reporting
 * `degraded: true` so the caller can tell "no index" from "no matches".
 *
 * Walks the `cause` chain because drizzle wraps driver errors, and matches on
 * errno, code, and message so a driver that surfaces only one of them still
 * degrades instead of failing.
 */
export function isMissingFulltextIndex(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur && depth < 5; depth++) {
    const e = cur as { errno?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (e.errno === 1191 || e.code === 'ER_FT_MATCHING_KEY_NOT_FOUND') return true;
    if (/can't find fulltext index/i.test(String(e.message ?? ''))) return true;
    cur = e.cause;
  }
  return false;
}
