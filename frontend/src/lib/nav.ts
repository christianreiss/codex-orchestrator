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
  CalendarClock,
  CircleUser,
  Cpu,
  FolderKanban,
  GitMerge,
  FileUp,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Library,
  Lock,
  MessageSquareShare,
  MessageSquareText,
  RadioTower,
  Server,
  ShieldCheck,
  SlidersHorizontal,
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
    description: "What needs attention, then fleet health", keywords: ["home", "health", "usage", "attention"], icon: LayoutDashboard,
  },
  {
    id: "hosts", group: "hosts", route: "/hosts", label: "Hosts",
    description: "Machines, their status and access", keywords: ["machines", "installers", "auth", "servers"], icon: Server,
  },
  {
    id: "agents", group: "agents", route: "/agents", label: "Agents",
    description: "Running agents, live, and how they are connected",
    keywords: ["clients", "topology", "sessions", "wrappers", "live", "presence", "working", "graph", "connections", "communicator", "cdx", "clx", "cgx"], icon: RadioTower,
  },
  {
    id: "projects", group: "projects", route: "/projects", label: "Projects",
    description: "Shared boards, documents and reports", keywords: ["coordination", "todos", "notes", "board"], icon: FolderKanban,
  },
  {
    id: "agent-messaging", group: "coordination", route: "/agent-messaging", label: "Messages",
    description: "Conversations between agents", keywords: ["agents", "codex", "claude", "grok", "relay", "messaging", "conference"], icon: MessageSquareShare,
  },
  {
    id: "schedules", group: "coordination", route: "/schedules", label: "Timed wake-ups",
    description: "Scheduled prompts and session recovery", keywords: ["wake", "cron", "schedule", "interval", "resume"], icon: CalendarClock,
  },
  {
    id: "git-director", group: "coordination", route: "/git-director", label: "Git merges",
    description: "Open merge requests and who is working where", keywords: ["git", "director", "worktree", "merge", "branch", "lease", "clone"], icon: GitMerge,
  },
  {
    id: "transfers", group: "coordination", route: "/transfers", label: "Shared files",
    description: "Files agents hand each other, and when they expire", keywords: ["file", "transfer", "upload", "download", "artifact", "ttl", "expiry"], icon: FileUp,
  },
  { id: "workflows", group: "coordination", route: "/workflows", label: "Workflows", description: "Reusable instructions, shared runs and reports", keywords: ["tasks", "runs", "evaluation", "reports"], icon: Waypoints },
  {
    id: "activity", group: "activity", route: "/activity", label: "Activity",
    description: "Configuration and system changes", keywords: ["audit", "logs", "events", "diagnostics", "troubleshooting"], icon: Activity,
  },
  {
    id: "reports", group: "activity", route: "/reports", label: "Reports",
    description: "Bugs and requests about the orchestrator itself", keywords: ["feedback", "bugs", "features", "improvements"], icon: MessageSquareText,
  },
  {
    id: "provider-accounts", group: "providers", route: "/accounts", label: "Accounts",
    description: "ChatGPT, Claude and Grok logins and their usage", keywords: ["accounts", "chatgpt", "claude", "grok", "quota", "credentials", "balance"], icon: UserRoundCog,
  },
  {
    id: "engines", group: "providers", route: "/engines", label: "Engines",
    description: "Switch engines on or off; default models and versions",
    keywords: ["models", "effort", "defaults", "versions", "codex", "claude", "grok", "sync", "native config", "danger"], icon: SlidersHorizontal,
  },
  {
    id: "limits", group: "providers", route: "/limits", label: "Usage limits",
    description: "Quota enforcement, quota warnings and usage-based scaling",
    keywords: ["quota", "limit", "usage", "scaling", "tiers", "warnings", "resume", "provider recommendation", "hard", "soft"], icon: Gauge,
  },
  {
    id: "library", group: "library", route: "/library", label: "Library",
    description: "Skills, agent rules, memories and Claude reply styles",
    keywords: ["skills", "skill", "instructions", "agent rules", "agents.md", "claude.md", "memory", "memories", "subagents", "commands", "output styles", "reply styles"], icon: Library,
    match: /^\/library(?:\/|$)/,
  },
  {
    id: "people", group: "access", route: "/people", label: "People",
    description: "Who can sign in to this console", keywords: ["users", "admin users", "roles", "access", "accounts", "sign in", "wipe"], icon: Users,
  },
  {
    id: "api-keys", group: "access", route: "/api-keys", label: "API keys",
    description: "Keys for the OpenAI, Anthropic and Grok gateways", keywords: ["keys", "access", "gateway", "openai", "anthropic", "grok", "proxy", "availability", "routing"], icon: KeyRound,
  },
  {
    id: "secrets", group: "access", route: "/secrets", label: "Secrets",
    description: "Credentials agents can read over MCP", keywords: ["access", "credential", "credentials", "vault", "mcp", "secret_get"], icon: Lock,
  },
  {
    id: "settings", group: "access", route: "/settings", label: "Settings",
    description: "Fleet-wide behavior: hosts, agent coordination, data retention", keywords: ["policies", "dns", "prune", "retention", "insecure", "auto-update", "approval", "coordination", "project rooms", "host rooms", "resource claims"], icon: ShieldCheck,
  },
  {
    id: "manual", group: "Utilities", route: "/manual", label: "Manual",
    description: "Operator documentation", keywords: ["help", "docs", "documentation"], icon: BookOpen,
  },
  {
    id: "account", group: "Utilities", route: "/account", label: "Account",
    description: "Profile, security, appearance and devices", keywords: ["password", "passkeys", "appearance", "theme", "devices"], icon: CircleUser,
    match: /^\/account(?:\/|$)/,
  },
];

export const NAV: NavItem[] = REGISTRY.map(define);

type HubDefinition = Omit<NavHub, "route" | "items">;

/** Rail order within a section is the order here. */
const HUB_DEFINITIONS: HubDefinition[] = [
  { id: "overview", section: "Operate", label: "Overview", description: "What needs attention", icon: LayoutDashboard, mobilePriority: 1 },
  { id: "hosts", section: "Operate", label: "Hosts", description: "Machines and their access", icon: Server, mobilePriority: 2 },
  { id: "agents", section: "Operate", label: "Agents", description: "Running agents, live", icon: RadioTower, mobilePriority: 4 },
  { id: "projects", section: "Operate", label: "Projects", description: "Boards, documents and reports", icon: FolderKanban, mobilePriority: 3 },
  { id: "coordination", section: "Operate", label: "Coordination", description: "Messages, workflows, wake-ups, git merges and shared files", icon: Waypoints },
  { id: "activity", section: "Operate", label: "Activity", description: "What changed, and reports about the orchestrator", icon: Activity },
  { id: "providers", section: "Configure", label: "Providers", description: "Provider accounts and engine defaults", icon: Cpu },
  { id: "library", section: "Configure", label: "Library", description: "Skills, agent rules, memories and reply styles", icon: Library },
  { id: "access", section: "Configure", label: "Access & Settings", description: "People, API keys, secrets and fleet-wide settings", icon: KeyRound },
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
  if (pathname.startsWith("/workflows/")) {
    const root = { label: "Workflows", route: "/workflows" };
    if (segments[1] === "runs") return segments[2] ? [root, { label: "Runs", route: "/workflows/runs" }, { label: "Run report" }] : [root, { label: "Runs" }];
    if (segments[1] === "definitions") return [root, { label: humanize(segments[2] ?? "Definition") }];
    return [root, { label: "New workflow" }];
  }
  if (pathname.startsWith("/hosts/")) return detailTrail({ label: "Hosts", route: "/hosts" }, `Host #${humanize(segments[1] ?? "")}`);
  if (pathname.startsWith("/projects/")) {
    const project = humanize(segments[1] ?? "");
    return segments[2]
      ? [{ label: "Projects", route: "/projects" }, { label: project, route: `/projects/${encodeURIComponent(segments[1] ?? "")}` }, { label: humanize(segments[2]) }]
      : detailTrail({ label: "Projects", route: "/projects" }, project);
  }
  if (pathname.startsWith("/library/")) {
    const kind = segments[1] === "agent-rules" ? "Agent rules" : humanize(segments[1] ?? "");
    return segments[2]
      ? [{ label: "Library", route: "/library" }, { label: kind, route: `/library?type=${encodeURIComponent(segments[1] ?? "")}` }, { label: humanize(segments[2]) }]
      : detailTrail({ label: "Library", route: "/library" }, kind);
  }
  if (pathname.startsWith("/manual/")) return detailTrail({ label: "Manual", route: "/manual" }, humanize(segments[1] ?? ""));
  if (pathname === "/login") return [{ label: "Sign in" }];
  if (pathname === "/password/reset") return [{ label: "Reset password" }];
  if (pathname.startsWith("/cli-auth")) return [{ label: "CLI authorization" }];
  if (pathname === "/setup") return [{ label: "Setup" }];

  const direct = CONTEXT_BY_ROUTE.get(pathname);
  if (direct) return [{ label: direct }];
  return segments.map((segment) => ({ label: humanize(segment) }));
}

/** Human-readable current location for the compact top bar and document title. */
export function getPageContext(pathname: string): string {
  return getBreadcrumbs(pathname).map((crumb) => crumb.label).join(" / ");
}

export function getDocumentTitle(pathname: string): string {
  return `${getPageContext(pathname)} · Codex Orchestrator`;
}
