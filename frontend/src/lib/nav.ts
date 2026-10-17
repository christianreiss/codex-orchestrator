/**
 * The console route registry.
 *
 * Navigation is deliberately data rather than markup: the desktop rail,
 * mobile sheet, hub tab strips, command palette, breadcrumbs, document titles
 * and active states all consume the same records. A page gets one stable id and
 * one owner; labels are never copied into an individual shell component.
 *
 * Two levels: `NAV` is every page (what the palette and breadcrumbs address),
 * `HUBS` groups those pages into the handful of rail entries. A hub's pages
 * share a route-group layout (`routes/(hub)/+layout.svelte`) that renders the
 * tab strip, so no URL depends on the grouping.
 */
import {
  Activity,
  BookOpen,
  Bot,
  Brain,
  CalendarClock,
  CircleUser,
  Cpu,
  FileText,
  FolderKanban,
  GitMerge,
  FileUp,
  KeyRound,
  LayoutDashboard,
  Library,
  Lock,
  MessageSquareShare,
  MessageSquareText,
  Palette,
  Network,
  RadioTower,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  UserRoundCog,
  Users,
  Waypoints,
} from "@lucide/svelte";
import type { Component } from "svelte";
import type { Engine } from "$lib/constants/engines";

export type HubId =
  | "overview"
  | "agents"
  | "projects"
  | "hosts"
  | "coordination"
  | "activity"
  | "providers"
  | "library"
  | "access";

/** A page belongs to exactly one hub; footer pages belong to none. */
export type NavGroup = HubId | "Utilities";

export type HubSection = "Operate" | "Configure";

export interface NavItem {
  /** Stable identifier for tests, analytics-free command ids, and persisted UI state. */
  id: string;
  group: NavGroup;
  /** Canonical client route, without SvelteKit's /admin base. */
  route: string;
  /** Compatibility alias for existing consumers; always mirrors route. */
  href: string;
  label: string;
  description: string;
  keywords: string[];
  icon: Component;
  /** A route matcher where a simple route prefix is not sufficient. */
  match?: RegExp;
  /** Optional label for the tab-strip row this page sits in (see TabNav `group`). */
  subgroup?: string;
  /**
   * The one engine this destination serves. Its tab is annotated while that
   * engine is switched off fleet-wide; it is never hidden, since the content
   * stays editable.
   */
  engine?: Engine;
}

/** One rail entry: a set of related pages behind a shared tab strip. */
export interface NavHub {
  id: HubId;
  section: HubSection;
  label: string;
  description: string;
  icon: Component;
  /** Where the rail entry links: the hub's first page. */
  route: string;
  /** Pages in tab order. */
  items: NavItem[];
  /** Lower values stay in the four-item mobile bar; all others live in Menu. */
  mobilePriority?: number;
}

export interface NavSection {
  id: string;
  label: HubSection;
  hubs: NavHub[];
}

/** A compact, route-derived trail for the persistent workspace header. */
export interface Breadcrumb {
  label: string;
  /** Canonical route for every ancestor; omit it for the current location. */
  route?: string;
}

type NavDefinition = Omit<NavItem, "href">;

function define(item: NavDefinition): NavItem {
  return { ...item, href: item.route };
}

/** Page order within a hub is tab order. */
const REGISTRY: NavDefinition[] = [
  {
    id: "overview", group: "overview", route: "/dashboard", label: "Overview",
    description: "Fleet health and exceptions", keywords: ["home", "health", "usage"], icon: LayoutDashboard,
  },
  {
    id: "clients", group: "agents", route: "/clients", label: "Active Clients",
    description: "Running agents and what they are working on",
    keywords: ["agents", "sessions", "wrappers", "live", "presence", "working", "cdx", "clx", "cgx"], icon: RadioTower,
  },
  {
    id: "topology", group: "agents", route: "/topology", label: "Live Topology",
    description: "Server, communicators and agents as a live connection map, with disconnect and stop controls",
    keywords: ["topology", "connections", "communicator", "graph", "radial", "map", "disconnect", "kill", "stop", "agents", "sockets"], icon: Network,
  },
  {
    id: "projects", group: "projects", route: "/projects", label: "Projects",
    description: "Shared coordination workspaces", keywords: ["coordination", "todos", "notes"], icon: FolderKanban,
  },
  {
    id: "hosts", group: "hosts", route: "/hosts", label: "Hosts",
    description: "Machines, credentials, and host policy", keywords: ["machines", "installers", "auth"], icon: Server,
  },
  {
    id: "agent-messaging", group: "coordination", route: "/agent-messaging", label: "Agent Messaging",
    description: "Addresses, conversations, and deliveries", keywords: ["agents", "codex", "claude", "grok", "relay"], icon: MessageSquareShare,
  },
  {
    id: "schedules", group: "coordination", route: "/schedules", label: "Wake / Cron",
    description: "Scheduled prompts and persistent session recovery", keywords: ["wake", "cron", "schedule", "interval", "resume"], icon: CalendarClock,
  },
  {
    id: "git-director", group: "coordination", route: "/git-director", label: "Git Director",
    description: "Clone registry and merge arbitration", keywords: ["git", "worktree", "merge", "branch", "lease", "clone"], icon: GitMerge,
  },
  {
    id: "transfers", group: "coordination", route: "/transfers", label: "File Transfer",
    description: "Files agents hand each other, and when they expire", keywords: ["file", "transfer", "upload", "download", "artifact", "ttl", "expiry"], icon: FileUp,
  },
  {
    id: "activity", group: "activity", route: "/logs/events", label: "Logs",
    description: "Audit trail and MCP requests", keywords: ["activity", "audit", "logs", "mcp", "events", "diagnostics", "troubleshooting"], icon: Activity,
    match: /^\/logs(?:\/|$)/,
  },
  {
    id: "feedback", group: "activity", route: "/feedback", label: "Feedback",
    description: "Orchestrator bugs, feature requests and verified fixes",
    keywords: ["bugs", "features", "reports", "improvements", "feedback"], icon: MessageSquareText,
  },
  {
    id: "provider-accounts", group: "providers", route: "/accounts", label: "Accounts",
    description: "ChatGPT, Claude, and Grok accounts, availability, and assignments", keywords: ["accounts", "chatgpt", "claude", "grok", "quota", "credentials", "balance"], icon: UserRoundCog,
  },
  {
    id: "engines", group: "providers", route: "/engines", label: "Engines",
    description: "Codex, Claude, and Grok defaults, versions, and switches",
    keywords: ["models", "effort", "defaults", "quick", "versions", "quota", "codex", "claude", "grok", "sync"], icon: SlidersHorizontal,
  },
  {
    id: "skills", group: "library", route: "/skills", label: "Skills", subgroup: "Shared",
    description: "Fleet skill manifests", keywords: ["skill", "manifest"], icon: BookOpen,
  },
  {
    id: "instructions", group: "library", route: "/instructions", label: "Fleet Instructions", subgroup: "Shared",
    description: "Shared AGENTS.md and CLAUDE.md instructions", keywords: ["agents.md", "claude.md", "codex", "claude", "grok", "instructions", "guidance"], icon: FileText,
  },
  {
    id: "memories", group: "library", route: "/memories", label: "Memories", subgroup: "Shared",
    description: "Shared, project, and host memory", keywords: ["atlas", "memory", "context"], icon: Brain,
  },
  {
    id: "subagents", group: "library", route: "/subagents", label: "Subagents", subgroup: "Claude-native",
    description: "Claude-native agent definitions", keywords: ["claude", "agents"], icon: Bot, engine: "claude",
  },
  {
    id: "commands", group: "library", route: "/commands", label: "Commands", subgroup: "Claude-native",
    description: "Claude-native slash commands", keywords: ["claude", "slash"], icon: Terminal, engine: "claude",
  },
  {
    id: "output-styles", group: "library", route: "/output-styles", label: "Output Styles", subgroup: "Claude-native",
    description: "Claude-native response styles", keywords: ["claude", "style"], icon: Palette, engine: "claude",
  },
  {
    id: "api-access", group: "access", route: "/api-keys", label: "API Access",
    description: "Service state, endpoints, and issued keys", keywords: ["openai", "anthropic", "proxy", "keys"], icon: KeyRound,
  },
  {
    id: "secrets", group: "access", route: "/secrets", label: "Secrets",
    description: "Credentials supplied over MCP", keywords: ["credential", "vault"], icon: Lock,
  },
  {
    id: "admin-users", group: "access", route: "/users", label: "Admin Users",
    description: "Accounts, roles, and access lifecycle", keywords: ["users", "roles", "accounts"], icon: Users,
  },
  {
    id: "policies", group: "access", route: "/policies", label: "Policies",
    description: "Fleet update, security, and retention rules", keywords: ["dns", "prune", "retention", "insecure"], icon: ShieldCheck,
  },
  {
    id: "manual", group: "Utilities", route: "/manual", label: "Manual",
    description: "Operator documentation", keywords: ["help", "docs", "documentation"], icon: BookOpen,
  },
  {
    id: "account", group: "Utilities", route: "/account/password", label: "Account",
    description: "Password, passkeys, and appearance", keywords: ["password", "passkeys", "appearance"], icon: CircleUser,
    match: /^\/account(?:\/|$)/,
  },
];

export const NAV: NavItem[] = REGISTRY.map(define);

type HubDefinition = Omit<NavHub, "route" | "items">;

/** Rail order within a section is the order here. */
const HUB_DEFINITIONS: HubDefinition[] = [
  { id: "overview", section: "Operate", label: "Overview", description: "Fleet health and exceptions", icon: LayoutDashboard, mobilePriority: 1 },
  { id: "agents", section: "Operate", label: "Agents", description: "Running agents and the live connection map", icon: RadioTower, mobilePriority: 4 },
  { id: "projects", section: "Operate", label: "Projects", description: "Shared coordination workspaces", icon: FolderKanban, mobilePriority: 3 },
  { id: "hosts", section: "Operate", label: "Hosts", description: "Machines, credentials, and host policy", icon: Server, mobilePriority: 2 },
  { id: "coordination", section: "Operate", label: "Coordination", description: "Messaging, wake schedules, git arbitration and file transfer", icon: Waypoints },
  { id: "activity", section: "Operate", label: "Activity", description: "Audit logs, MCP requests and orchestrator feedback", icon: Activity },
  { id: "providers", section: "Configure", label: "Providers", description: "Provider accounts, engine defaults, versions and switches", icon: Cpu },
  { id: "library", section: "Configure", label: "Library", description: "Skills, instructions, memory and Claude-native definitions", icon: Library },
  { id: "access", section: "Configure", label: "Access & Policy", description: "API keys, secrets, admin users and fleet policies", icon: KeyRound },
];

export const HUBS: NavHub[] = HUB_DEFINITIONS.map((hub) => {
  const items = NAV.filter((item) => item.group === hub.id);
  return { ...hub, items, route: items[0]?.route ?? "/dashboard" };
});

export const NAV_SECTIONS: NavSection[] = (["Operate", "Configure"] as const).map((label) => ({
  id: label.toLowerCase(),
  label,
  hubs: HUBS.filter((hub) => hub.section === label),
}));
export const NAV_FOOTER: NavItem[] = NAV.filter((item) => item.group === "Utilities");

/** Mobile keeps only the recurring operational destinations on the persistent bar. */
export const MOBILE_NAV_PRIMARY = HUBS.filter((hub) => hub.mobilePriority !== undefined).sort(
  (a, b) => (a.mobilePriority ?? Infinity) - (b.mobilePriority ?? Infinity),
);
export const MOBILE_NAV_OVERFLOW = HUBS.filter((hub) => !MOBILE_NAV_PRIMARY.includes(hub));

export function isActive(target: NavItem | NavHub, pathname: string): boolean {
  if ("items" in target) return target.items.some((item) => isActive(item, pathname));
  if (target.match) return target.match.test(pathname);
  return pathname === target.route || pathname.startsWith(target.route + "/");
}

export function hubFor(pathname: string): NavHub | undefined {
  return HUBS.find((hub) => isActive(hub, pathname));
}

function humanize(segment: string): string {
  try {
    const value = decodeURIComponent(segment).replace(/[-_]/g, " ");
    return value ? value[0].toUpperCase() + value.slice(1) : value;
  } catch {
    const value = segment.replace(/[-_]/g, " ");
    return value ? value[0].toUpperCase() + value.slice(1) : value;
  }
}

const CONTEXT_BY_ROUTE = new Map(NAV.map((item) => [item.route, item.label]));

function detailTrail(parent: Breadcrumb, detail: string): Breadcrumb[] {
  return [parent, { label: detail }];
}

/**
 * Produces the visible breadcrumb trail from the same registry that owns
 * navigation and document titles. Detail labels deliberately stay textual:
 * the parent route is the only stable, linkable ancestor for mutable objects.
 */
export function getBreadcrumbs(pathname: string): Breadcrumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0 || pathname === "/dashboard") return [{ label: "Overview" }];
  if (pathname === "/logs" || pathname.startsWith("/logs/")) {
    return detailTrail({ label: "Logs", route: "/logs/events" }, pathname.startsWith("/logs/mcp") ? "MCP requests" : "Audit trail");
  }
  if (pathname === "/hosts/new") return detailTrail({ label: "Hosts", route: "/hosts" }, "Register host");
  if (pathname.startsWith("/hosts/")) return detailTrail({ label: "Hosts", route: "/hosts" }, `Host #${humanize(segments[1] ?? "")}`);
  if (pathname.startsWith("/projects/")) {
    const project = humanize(segments[1] ?? "");
    return segments[2]
      ? [{ label: "Projects", route: "/projects" }, { label: project, route: `/projects/${encodeURIComponent(segments[1] ?? "")}` }, { label: humanize(segments[2]) }]
      : detailTrail({ label: "Projects", route: "/projects" }, project);
  }
  if (pathname.startsWith("/skills/")) return detailTrail({ label: "Skills", route: "/skills" }, humanize(segments[1] ?? ""));
  if (pathname.startsWith("/subagents/")) return detailTrail({ label: "Subagents", route: "/subagents" }, humanize(segments[1] ?? ""));
  if (pathname.startsWith("/commands/")) return detailTrail({ label: "Commands", route: "/commands" }, humanize(segments[1] ?? ""));
  if (pathname.startsWith("/output-styles/")) return detailTrail({ label: "Output Styles", route: "/output-styles" }, humanize(segments[1] ?? ""));
  if (pathname.startsWith("/manual/")) return detailTrail({ label: "Manual", route: "/manual" }, humanize(segments[1] ?? ""));
  if (pathname.startsWith("/account/")) return detailTrail({ label: "Account", route: "/account/password" }, segments[1] === "theme" ? "Appearance" : humanize(segments[1] ?? ""));
  if (pathname === "/login") return [{ label: "Sign in" }];
  if (pathname === "/password/reset") return [{ label: "Reset password" }];
  if (pathname.startsWith("/cli-auth")) return [{ label: "CLI authorization" }];
  if (pathname === "/setup") return [{ label: "Setup" }];

  const direct = CONTEXT_BY_ROUTE.get(pathname);
  if (direct) return [{ label: direct }];

  // Compatibility paths stay understandable while the client redirects them.
  if (pathname.startsWith("/settings")) return [{ label: "Configuration" }];
  if (pathname.startsWith("/authoring")) return [{ label: "Knowledge" }];
  return segments.map((segment) => ({ label: humanize(segment) }));
}

/** Human-readable current location for the compact top bar and document title. */
export function getPageContext(pathname: string): string {
  return getBreadcrumbs(pathname).map((crumb) => crumb.label).join(" / ");
}

export function getDocumentTitle(pathname: string): string {
  return `${getPageContext(pathname)} · Codex Orchestrator`;
}
