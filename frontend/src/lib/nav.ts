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

/** Human-readable current location for the compact top bar and document title. */
export function getPageContext(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0 || pathname === "/dashboard") return "Overview";
  if (pathname === "/logs" || pathname.startsWith("/logs/")) {
    return pathname.startsWith("/logs/mcp") ? "Activity / MCP requests" : "Activity / Audit trail";
  }
  if (pathname === "/hosts/new") return "Hosts / Register host";
  if (pathname.startsWith("/hosts/")) return `Hosts / Host #${humanize(segments[1] ?? "")}`;
  if (pathname.startsWith("/projects/")) {
    return `Projects / ${humanize(segments[1] ?? "")}${segments[2] ? ` / ${humanize(segments[2])}` : ""}`;
  }
  if (pathname.startsWith("/skills/")) return `Skills / ${humanize(segments[1] ?? "")}`;
  if (pathname.startsWith("/subagents/")) return `Subagents / ${humanize(segments[1] ?? "")}`;
  if (pathname.startsWith("/commands/")) return `Commands / ${humanize(segments[1] ?? "")}`;
  if (pathname.startsWith("/output-styles/")) return `Output Styles / ${humanize(segments[1] ?? "")}`;
  if (pathname.startsWith("/manual/")) return `Manual / ${humanize(segments[1] ?? "")}`;
  if (pathname.startsWith("/account/")) return `Account / ${segments[1] === "theme" ? "Appearance" : humanize(segments[1] ?? "")}`;
  if (pathname === "/login") return "Sign in";
  if (pathname === "/password/reset") return "Reset password";
  if (pathname.startsWith("/cli-auth")) return "CLI authorization";
  if (pathname === "/setup") return "Setup";

  const direct = CONTEXT_BY_ROUTE.get(pathname);
  if (direct) return direct;

  // Compatibility paths stay understandable while the client redirects them.
  if (pathname.startsWith("/settings")) return "Configuration";
  if (pathname.startsWith("/authoring")) return "Knowledge";
  return segments.map(humanize).join(" / ");
}

export function getDocumentTitle(pathname: string): string {
  return `${getPageContext(pathname)} · Codex Orchestrator`;
}
