/**
 * The console route registry.
 *
 * Navigation is deliberately data rather than markup: the desktop rail,
 * mobile sheet, command palette, breadcrumbs, document titles and active
 * states all consume the same records. A route gets one stable id and one
 * owner; labels are never copied into an individual shell component.
 */
import {
  Activity,
  BookOpen,
  Bot,
  Brain,
  FileText,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  Link,
  MessageSquareShare,
  Palette,
  Server,
  Settings,
  ShieldCheck,
  Terminal,
  Users,
} from "@lucide/svelte";
import type { Component } from "svelte";

export type NavGroup = "Monitor" | "Fleet" | "Coordinate" | "Knowledge" | "Access" | "Utilities";

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
  /** Lower values stay in the four-item mobile bar; all others live in Menu. */
  mobilePriority?: number;
}

export interface NavSection {
  id: string;
  label: NavGroup;
  items: NavItem[];
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

const REGISTRY: NavDefinition[] = [
  {
    id: "overview", group: "Monitor", route: "/dashboard", label: "Overview",
    description: "Fleet health and exceptions", keywords: ["home", "health", "usage"], icon: LayoutDashboard,
    mobilePriority: 1,
  },
  {
    id: "activity", group: "Monitor", route: "/logs/events", label: "Activity",
    description: "Audit trail and MCP requests", keywords: ["audit", "logs", "mcp", "events"], icon: Activity,
    match: /^\/logs(?:\/|$)/, mobilePriority: 4,
  },
  {
    id: "hosts", group: "Fleet", route: "/hosts", label: "Hosts",
    description: "Machines, credentials, and host policy", keywords: ["machines", "installers", "auth"], icon: Server,
    mobilePriority: 2,
  },
  {
    id: "engines", group: "Fleet", route: "/engines", label: "Engines",
    description: "Codex and Claude defaults", keywords: ["models", "versions", "quota", "claude"], icon: Settings,
  },
  {
    id: "policies", group: "Fleet", route: "/policies", label: "Policies",
    description: "Fleet update, security, and retention rules", keywords: ["dns", "prune", "retention", "insecure"], icon: ShieldCheck,
  },
  {
    id: "projects", group: "Coordinate", route: "/projects", label: "Projects",
    description: "Shared coordination workspaces", keywords: ["coordination", "todos", "notes"], icon: FolderKanban,
    mobilePriority: 3,
  },
  {
    id: "agent-messaging", group: "Coordinate", route: "/agent-messaging", label: "Agent Messaging",
    description: "Addresses, conversations, and deliveries", keywords: ["agents", "codex", "claude", "relay"], icon: MessageSquareShare,
  },
  {
    id: "agent-portal", group: "Coordinate", route: "/agent-portal", label: "Agent Portal",
    description: "Portal access and permanent links", keywords: ["remote", "portal", "links"], icon: Link,
  },
  {
    id: "skills", group: "Knowledge", route: "/skills", label: "Skills",
    description: "Fleet skill manifests", keywords: ["skill", "manifest"], icon: BookOpen,
  },
  {
    id: "instructions", group: "Knowledge", route: "/instructions", label: "Fleet Instructions",
    description: "Shared AGENTS instructions", keywords: ["agents.md", "instructions", "guidance"], icon: FileText,
  },
  {
    id: "memories", group: "Knowledge", route: "/memories", label: "Memories",
    description: "Shared, project, and host memory", keywords: ["atlas", "memory", "context"], icon: Brain,
  },
  {
    id: "subagents", group: "Knowledge", route: "/subagents", label: "Subagents",
    description: "Claude-native agent definitions", keywords: ["claude", "agents"], icon: Bot,
  },
  {
    id: "commands", group: "Knowledge", route: "/commands", label: "Commands",
    description: "Claude-native slash commands", keywords: ["claude", "slash"], icon: Terminal,
  },
  {
    id: "output-styles", group: "Knowledge", route: "/output-styles", label: "Output Styles",
    description: "Claude-native response styles", keywords: ["claude", "style"], icon: Palette,
  },
  {
    id: "api-access", group: "Access", route: "/api-keys", label: "API Access",
    description: "Service state, endpoints, and issued keys", keywords: ["openai", "anthropic", "proxy", "keys"], icon: KeyRound,
  },
  {
    id: "secrets", group: "Access", route: "/secrets", label: "Secrets",
    description: "Credentials supplied over MCP", keywords: ["credential", "vault"], icon: ShieldCheck,
  },
  {
    id: "admin-users", group: "Access", route: "/users", label: "Admin Users",
    description: "Accounts, roles, and access lifecycle", keywords: ["users", "roles", "accounts"], icon: Users,
  },
  {
    id: "manual", group: "Utilities", route: "/manual", label: "Manual",
    description: "Operator documentation", keywords: ["help", "docs", "documentation"], icon: BookOpen,
  },
  {
    id: "account", group: "Utilities", route: "/account/password", label: "Account",
    description: "Password, passkeys, and appearance", keywords: ["password", "passkeys", "appearance"], icon: Users,
  },
];

export const NAV: NavItem[] = REGISTRY.map(define);
export const NAV_SECTIONS: NavSection[] = (["Monitor", "Fleet", "Coordinate", "Knowledge", "Access"] as const).map(
  (group) => ({ id: group.toLowerCase(), label: group, items: NAV.filter((item) => item.group === group) }),
);
export const NAV_FOOTER: NavItem[] = NAV.filter((item) => item.group === "Utilities");

/** Mobile keeps only the recurring operational destinations on the persistent bar. */
export const MOBILE_NAV_PRIMARY = NAV.filter((item) => item.mobilePriority !== undefined).sort(
  (a, b) => (a.mobilePriority ?? Infinity) - (b.mobilePriority ?? Infinity),
);
export const MOBILE_NAV_OVERFLOW = NAV.filter((item) => !MOBILE_NAV_PRIMARY.includes(item));

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.match) return item.match.test(pathname);
  return pathname === item.route || pathname.startsWith(item.route + "/");
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
    return detailTrail({ label: "Activity", route: "/logs/events" }, pathname.startsWith("/logs/mcp") ? "MCP requests" : "Audit trail");
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
