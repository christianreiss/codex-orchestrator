/**
 * Navigation and route presentation registry.
 *
 * The sidebar, mobile navigation, command palette, breadcrumbs, and document
 * titles all consume this file so labels stay consistent across the SPA.
 */
import {
  Activity,
  BookOpen,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  Server,
  Settings,
} from "@lucide/svelte";
import type { Component } from "svelte";

export interface NavItem {
  href: string;
  label: string;
  icon: Component;
  description: string;
  /** Optional regex; if absent, exact-or-prefix match on `href` is used. */
  match?: RegExp;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Operate",
    items: [
      {
        href: "/dashboard",
        label: "Overview",
        icon: LayoutDashboard,
        description: "Fleet health and usage",
      },
      { href: "/hosts", label: "Hosts", icon: Server, description: "Machines and credentials" },
      {
        href: "/projects",
        label: "Projects",
        icon: FolderKanban,
        description: "Shared coordination workspaces",
      },
    ],
  },
  {
    label: "Create",
    items: [
      {
        href: "/authoring",
        label: "Authoring",
        icon: BookOpen,
        description: "Fleet context and Claude artifacts",
      },
    ],
  },
  {
    label: "Observe",
    items: [
      {
        href: "/logs/events",
        label: "Activity",
        icon: Activity,
        description: "Audit trail and MCP calls",
        match: /^\/logs(\/|$)/,
      },
    ],
  },
  {
    label: "Manage",
    items: [
      {
        href: "/api-keys",
        label: "API access",
        icon: KeyRound,
        description: "Endpoints, keys, and availability",
      },
      {
        href: "/settings",
        label: "Settings",
        icon: Settings,
        description: "Fleet policy and admin users",
        match: /^\/settings(\/|$)/,
      },
    ],
  },
];

export const NAV: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/** Mobile keeps the four highest-frequency workflows one tap away. */
export const MOBILE_NAV_PRIMARY: NavItem[] = NAV.filter((item) =>
  ["/dashboard", "/hosts", "/projects", "/authoring"].includes(item.href),
);

export const MOBILE_NAV_OVERFLOW: NavItem[] = NAV.filter(
  (item) => !MOBILE_NAV_PRIMARY.includes(item),
);

/** Returns true if the supplied pathname is under the nav item's route. */
export function isActive(item: NavItem, pathname: string): boolean {
  if (item.match) return item.match.test(pathname);
  if (pathname === item.href) return true;
  return pathname.startsWith(item.href + "/");
}

function humanize(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Keep the raw segment if a malformed escape reaches the client.
  }
  const value = decoded.replace(/[-_]/g, " ");
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/** Human-readable location for the top bar and browser title. */
export function getPageContext(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "Overview";

  if (segments[0] === "dashboard") return "Overview";
  if (segments[0] === "hosts") {
    if (segments[1] === "new") return "Hosts / Register host";
    return segments[1] ? `Hosts / Host #${humanize(segments[1])}` : "Hosts";
  }
  if (segments[0] === "projects") {
    if (!segments[1]) return "Projects";
    const tab = segments[2] ? ` / ${humanize(segments[2])}` : "";
    return `Projects / ${humanize(segments[1])}${tab}`;
  }
  if (segments[0] === "api-keys") return "API access";
  if (segments[0] === "authoring") {
    const section = segments[1] ?? "skills";
    const sectionLabel = humanize(section);
    const detail = segments[2] ? ` / ${humanize(segments[2])}` : "";
    return `Authoring / ${sectionLabel}${detail}`;
  }
  if (segments[0] === "logs") {
    return segments[1] === "mcp" ? "Activity / MCP requests" : "Activity / Audit trail";
  }
  if (segments[0] === "settings") {
    return segments[1] === "users" ? "Settings / Users & access" : "Settings";
  }
  if (segments[0] === "account") {
    if (!segments[1]) return "Account";
    const section = segments[1] === "theme" ? "Appearance" : humanize(segments[1]);
    return `Account / ${section}`;
  }
  if (segments[0] === "manual") {
    return segments[1] ? `Manual / ${humanize(segments[1])}` : "Manual";
  }
  if (segments[0] === "login") return "Sign in";
  if (segments[0] === "cli-auth") return "CLI authorization";
  return segments.map(humanize).join(" / ");
}

export function getDocumentTitle(pathname: string): string {
  return `${getPageContext(pathname)} · Codex Orchestrator`;
}
