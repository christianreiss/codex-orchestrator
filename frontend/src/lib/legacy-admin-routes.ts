/** Stable mappings for bookmarks from the retired Settings/Authoring hubs. */
const SETTINGS_SECTION_DESTINATIONS: Record<string, string> = {
  "api-state": "/api-keys#service-availability",
  "openai-engine": "/api-keys#openai-proxy",
  "claude-engine": "/api-keys#claude-proxy",
  "agent-messaging": "/agent-messaging#service-state",
  "codex-model-defaults": "/engines#codex-defaults",
  "claude-model-defaults": "/engines#claude-defaults",
  "codex-version": "/engines#codex-defaults",
  "claude-version": "/engines#claude-defaults",
  "cdx-silent": "/engines#codex-defaults",
  quotas: "/engines#quota-enforcement",
  scaling: "/engines#quota-enforcement",
  "claude-fleet-settings": "/engines#claude-client",
  "auto-update": "/policies#fleet-behavior",
  "reverse-dns": "/policies#fleet-behavior",
  "insecure-approval": "/policies#insecure-approval",
  "prune-policy": "/policies#host-lifecycle",
  "log-retention": "/policies#log-retention",
  "agent-portal": "/agent-portal",
};

export function settingsLegacyTarget(search: URLSearchParams, hash = ""): string {
  const section = decodeURIComponent(hash.replace(/^#/, ""));
  if (SETTINGS_SECTION_DESTINATIONS[section]) return SETTINGS_SECTION_DESTINATIONS[section]!;
  switch (search.get("tab")) {
    case "engines":
    case "codex":
    case "claude": return "/engines";
    case "fleet-policy": return "/policies";
    case "claude-config": return "/engines#claude-client";
    case "availability":
    case "general":
    default: return "/api-keys#service-availability";
  }
}

export function legacyAuthoringTarget(pathSuffix: string): string {
  if (pathSuffix.startsWith("/skills/")) return `/skills/${pathSuffix.slice("/skills/".length)}`;
  if (pathSuffix === "/agents") return "/instructions";
  if (pathSuffix === "/memories") return "/memories";
  if (pathSuffix.startsWith("/subagents") || pathSuffix.startsWith("/commands") || pathSuffix.startsWith("/output-styles")) return pathSuffix;
  if (pathSuffix.startsWith("/settings")) return "/engines#claude-client";
  return "/skills";
}
