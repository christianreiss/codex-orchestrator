/**
 * Top-level navigation registry. Single source of truth for the sidebar
 * + mobile bottom tab bar. Feature agents in Phase 2 do not modify this;
 * they only touch their own route files.
 */
import {
  LayoutDashboard,
  Server,
  FolderKanban,
  KeyRound,
  BookOpen,
  ScrollText,
  Users,
  Settings,
} from "@lucide/svelte";
import type { Component } from "svelte";

export interface NavItem {
  href: string;
  label: string;
  icon: Component;
  /** Optional regex; if absent, exact-or-prefix match on `href` is used. */
  match?: RegExp;
}

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/hosts", label: "Hosts", icon: Server },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/api-keys", label: "API Keys", icon: KeyRound },
  { href: "/authoring", label: "Authoring", icon: BookOpen },
  { href: "/logs/api", label: "Logs", icon: ScrollText, match: /^\/logs(\/|$)/ },
  { href: "/users", label: "Users", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** Items shown in the mobile bottom tab bar (the rest go in overflow). */
export const MOBILE_NAV_PRIMARY: NavItem[] = NAV.filter((n) =>
  ["/dashboard", "/hosts", "/projects", "/logs/api", "/settings"].includes(n.href),
);

/** Items shown in the mobile overflow sheet. */
export const MOBILE_NAV_OVERFLOW: NavItem[] = NAV.filter(
  (n) => !MOBILE_NAV_PRIMARY.includes(n),
);

/** Returns true if the supplied pathname is "under" the nav item's href. */
export function isActive(item: NavItem, pathname: string): boolean {
  if (item.match) return item.match.test(pathname);
  if (pathname === item.href) return true;
  return pathname.startsWith(item.href + "/");
}
