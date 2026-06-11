import { formatDistanceToNowStrict } from "date-fns";

/**
 * Returns "in 4 minutes" / "4 minutes ago" style strings.
 * Accepts Date, ISO string, or Unix timestamp (seconds or ms).
 */
export function relativeTime(input: Date | string | number | null | undefined): string {
  if (input === null || input === undefined || input === "") return "";
  let date: Date;
  if (input instanceof Date) {
    date = input;
  } else if (typeof input === "number") {
    // Heuristic: seconds vs ms
    date = new Date(input < 1e12 ? input * 1000 : input);
  } else {
    date = new Date(input);
  }
  if (Number.isNaN(date.getTime())) return "";
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

/** Format byte size as KB/MB/GB string. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "0 B";
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (abs < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
