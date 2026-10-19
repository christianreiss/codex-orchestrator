/**
 * Every retired admin URL and where it lives now.
 *
 * One pure function answers for all of them, and the catch-all route
 * (`routes/[...legacy]/+page.ts`) applies it. A retired URL therefore needs no
 * stub page of its own: SvelteKit only matches a route that has a component,
 * so per-URL redirect stubs used to rot as 2-line files across the tree.
 */

/** Section hashes and `?tab=` values from the retired Settings hub. */
const SETTINGS_SECTION_DESTINATIONS: Record<string, string> = {
  "api-state": "/api-keys",
  "openai-engine": "/api-keys",
  "engine-state": "/engines#engine-state",
  "claude-engine": "/api-keys",
  "agent-messaging": "/agent-messaging",
  "codex-model-defaults": "/engines#codex-defaults",
  "claude-model-defaults": "/engines#claude-defaults",
  "codex-version": "/engines#codex-defaults",
  "claude-version": "/engines#claude-defaults",
  "cdx-silent": "/engines#codex-defaults",
  quotas: "/engines#quota-enforcement",
  scaling: "/engines#quota-enforcement",
  "claude-fleet-settings": "/engines#claude-client",
  "auto-update": "/settings#hosts",
  "reverse-dns": "/settings#hosts",
  "insecure-approval": "/settings#hosts",
  "prune-policy": "/settings#hosts",
  "log-retention": "/settings#retention",
};

/** Maps a retired `/settings?tab=…#section` bookmark; null when the URL is a current Settings URL. */
export function settingsLegacyTarget(search: URLSearchParams, hash = ""): string | null {
  const section = decodeURIComponent(hash.replace(/^#/, ""));
  if (SETTINGS_SECTION_DESTINATIONS[section]) return SETTINGS_SECTION_DESTINATIONS[section]!;
  switch (search.get("tab")) {
    case "engines":
    case "codex":
    case "claude": return "/engines";
    case "fleet-policy": return "/settings";
    case "claude-config": return "/engines#claude-client";
    case "availability":
    case "general": return "/api-keys";
    default: return null;
  }
}

const LIBRARY_TYPES = new Set(["skills", "subagents", "commands", "output-styles"]);

function withQuery(path: string, search: URLSearchParams, extra?: Record<string, string>): string {
  const merged = new URLSearchParams(search);
  for (const [key, value] of Object.entries(extra ?? {})) merged.set(key, value);
  const query = merged.toString();
  if (!query) return path;
  const [route, hash] = path.split("#");
  return `${route}${route!.includes("?") ? "&" : "?"}${query}${hash ? `#${hash}` : ""}`;
}

/** Hashes of the API keys page's "Configure" panel; the page opens it and scrolls to the target. */
const API_KEY_CONFIG_ANCHORS = new Set(["configuration", "service-availability", "api-state", "exposed-apis", "backend-settings", "claude-proxy", "claude-engine", "grok-proxy", "grok-engine"]);

/** `/access` was one page with `#people`, `#api-keys` and `#secrets` sections; each is a page now. */
function accessTarget(search: URLSearchParams, hash: string): string {
  const section = decodeURIComponent(hash.replace(/^#/, ""));
  if (section === "secrets") return withQuery("/secrets", search);
  if (section === "api-keys") return withQuery("/api-keys", search);
  if (API_KEY_CONFIG_ANCHORS.has(section)) return `${withQuery("/api-keys", search)}#${section}`;
  if (section === "people") return withQuery("/people", search);
  if (search.has("dialog")) return withQuery("/api-keys", search);
  return withQuery("/people", search);
}

/**
 * The current location of a retired URL, or null when the path was never a
 * route. `pathname` is base-relative (no `/admin`).
 */
export function legacyTarget(pathname: string, search = new URLSearchParams(), hash = ""): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean);
  const [head = "", second, third] = segments;

  switch (head) {
    case "clients": return withQuery("/agents", search);
    case "topology": return withQuery("/agents", search, { view: "graph" });
    case "feedback": return withQuery("/reports", search);
    case "logs": return withQuery("/activity", search, { type: second === "mcp" ? "tools" : "changes" });
    case "access": return accessTarget(search, hash);
    case "users": return withQuery("/people", search);
    case "policies": return hash ? `/settings${hash}` : "/settings";
    case "quick-settings": return "/engines#defaults";
    case "instructions": return "/library/agent-rules";
    case "memories": return withQuery("/library", search, { type: "memories" });
    case "hosts": return second === "new" ? "/hosts?add=1" : null;
    case "settings":
      if (second === "users") return "/people";
      return segments.length === 1 ? settingsLegacyTarget(search, hash) : null;
    case "account":
      if (second === "theme") return "/account#appearance";
      if (second === "devices") return "/account#devices";
      if (second === "password" || second === "passkeys") return "/account#security";
      return null;
    case "authoring": {
      if (second === "agents") return "/library/agent-rules";
      if (second === "memories") return withQuery("/library", search, { type: "memories" });
      if (second === "settings") return "/engines#claude-client";
      if (second && LIBRARY_TYPES.has(second)) return legacyTarget(`/${second}${third ? `/${third}` : ""}`, search, hash);
      return withQuery("/library", search, { type: "skills" });
    }
    case "projects": {
      if (!second) return null;
      const slug = encodeURIComponent(decodeURIComponent(second));
      switch (third) {
        case "todos": return `/projects/${slug}/board`;
        case "notes": return `/projects/${slug}/documents?kind=notes`;
        case "files": return `/projects/${slug}/documents?kind=files`;
        case "feedback": return `/projects/${slug}/reports`;
        default: return null;
      }
    }
    default:
      if (LIBRARY_TYPES.has(head)) {
        return second
          ? `/library/${head}/${second}`
          : withQuery("/library", search, { type: head });
      }
      return null;
  }
}
