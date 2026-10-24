/**
 * Collapse the spellings of one remote onto one string.
 *
 * `git@host:org/repo.git` and `https://host/org/repo` are the same repository
 * and must hash the same, or cross-host grouping silently never groups — a
 * failure with no error and no symptom beyond clones that stubbornly refuse to
 * appear related. Strips scheme and userinfo, lowercases the host, and drops a
 * trailing `.git` and any trailing slash.
 */
export function normalizeRemote(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let rest = value;
  // scheme://  or  scp-like  user@host:path
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
  } else {
    const scp = /^([^/@]+@)?([^/:]+):(.+)$/.exec(rest);
    if (scp) rest = `${scp[2]}/${scp[3]}`;
  }
  const at = rest.indexOf('@');
  const firstSlash = rest.indexOf('/');
  // userinfo only counts before the first path separator
  if (at !== -1 && (firstSlash === -1 || at < firstSlash)) rest = rest.slice(at + 1);
  const slash = rest.indexOf('/');
  let host = slash === -1 ? rest : rest.slice(0, slash);
  let path = slash === -1 ? '' : rest.slice(slash + 1);
  host = host.toLowerCase().replace(/:\d+$/, '');
  // Order matters: a trailing slash has to go first, or `…/repo.git/` keeps its
  // `.git` and stops matching the same repo cloned over ssh. Strip again after,
  // since removing the suffix can expose another separator.
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return path ? `${host}/${path}` : host;
}
