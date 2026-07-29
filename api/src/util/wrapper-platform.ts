import type { IncomingHttpHeaders } from 'node:http';

export interface WrapperPlatform {
  os: string;
  arch: string;
}

/**
 * Resolves the platform whose binary the calling wrapper should be offered.
 *
 * `X-Wrapper-Platform: os-arch` wins when well formed (both `cdx` and `clx`
 * send it), otherwise the user agent is sniffed, otherwise `linux-amd64`.
 * Shared by /wrapper/v2/* (signed config + download) and /cron/check (the
 * self-update URL and sha) so both stay on one rule.
 */
export function resolveWrapperPlatform(headers: IncomingHttpHeaders): WrapperPlatform {
  const ua = headerString(headers['user-agent']) ?? '';
  const xPlat = headerString(headers['x-wrapper-platform']) ?? '';
  const fromHeader = /^([a-z0-9]+)-([a-z0-9]+)$/.exec(xPlat);
  if (fromHeader && fromHeader[1] && fromHeader[2]) {
    return { os: fromHeader[1], arch: fromHeader[2] };
  }
  let os = 'linux';
  let arch = 'amd64';
  if (/darwin|mac/i.test(ua)) os = 'darwin';
  if (/arm64|aarch64/i.test(ua)) arch = 'arm64';
  return { os, arch };
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}
