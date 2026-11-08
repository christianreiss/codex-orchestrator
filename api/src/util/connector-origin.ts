/** Normalize configured web origins without ever admitting URL credentials. */
function webUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}
export function canonicalConnectorOrigin(value: string | undefined): string | null {
  const url = webUrl(value);
  return url?.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
}
export function canonicalDashboardOrigin(value: string | undefined): string | null {
  return webUrl(value)?.origin ?? null;
}
