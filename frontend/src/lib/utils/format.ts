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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function counted(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Quota reset relative to now.
 * A day or more is whole days ("in 6 days"). Sooner resets keep the largest
 * unit ("in 3 hours", "in 42 minutes") so a 5-hour window is not "in 0 days".
 * "passed" means the instant is already here. "" means missing or unparseable.
 */
export function resetsIn(input: Date | string | number | null | undefined, now = Date.now()): string {
  if (input === null || input === undefined || input === "") return "";
  const date =
    input instanceof Date
      ? input
      : new Date(typeof input === "number" ? (input < 1e12 ? input * 1000 : input) : input);
  const time = date.getTime();
  if (Number.isNaN(time)) return "";
  const remaining = time - now;
  if (remaining <= 0) return "passed";
  if (remaining >= DAY_MS) {
    return `in ${counted(Math.max(1, Math.round(remaining / DAY_MS)), "day")}`;
  }
  if (remaining >= HOUR_MS) {
    const hours = Math.max(1, Math.round(remaining / HOUR_MS));
    return hours >= 24 ? "in 1 day" : `in ${counted(hours, "hour")}`;
  }
  const minutes = Math.max(1, Math.round(remaining / MINUTE_MS));
  return minutes >= 60 ? "in 1 hour" : `in ${counted(minutes, "minute")}`;
}

type DateInput = Date | string | number | null | undefined;

/** Date, ISO string or Unix timestamp (seconds or ms); null when missing or unparseable. */
export function toDate(input: DateInput): Date | null {
  if (input === null || input === undefined || input === "") return null;
  const date = input instanceof Date ? input : new Date(typeof input === "number" ? (input < 1e12 ? input * 1000 : input) : input);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface ZonedFormatOptions {
  /** BCP 47 locale; defaults to the browser's. */
  locale?: string;
  /** IANA zone; defaults to the browser's local zone. */
  timeZone?: string;
  /** Include seconds (event logs); minutes otherwise. */
  seconds?: boolean;
}

function zoned(input: DateInput, fields: Intl.DateTimeFormatOptions, options: ZonedFormatOptions): string {
  const date = toDate(input);
  if (!date) return "";
  return new Intl.DateTimeFormat(options.locale, {
    ...fields,
    hour: "2-digit",
    minute: "2-digit",
    ...(options.seconds ? { second: "2-digit" } : {}),
    timeZoneName: "short",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

/**
 * Absolute date and time that names its zone, e.g. "5 Nov 2026, 21:18 CET".
 * Use this instead of a bare toLocaleString(): an operator comparing hosts
 * across zones must see which clock a time was read on. "" when missing.
 */
export function formatDateTime(input: DateInput, options: ZonedFormatOptions = {}): string {
  return zoned(input, { year: "numeric", month: "short", day: "numeric" }, options);
}

/** Time of day with its zone, e.g. "21:18 CET", for same-day event rows. "" when missing. */
export function formatTime(input: DateInput, options: ZonedFormatOptions = {}): string {
  return zoned(input, {}, options);
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
