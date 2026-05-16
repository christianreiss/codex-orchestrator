/**
 * Cmd-K command registry. Static commands are declared inline here.
 * Feature agents in Phase 2 register dynamic command sources via
 * `registerCommandSource(fn)` — each source returns commands matching
 * the current search input.
 */
import type { Component } from "svelte";
import {
  LayoutDashboard,
  Server,
  FolderKanban,
  KeyRound,
  BookOpen,
  ScrollText,
  Users,
  Plug,
  Settings,
  Sun,
  Moon,
  Monitor,
  LogOut,
  Keyboard,
} from "@lucide/svelte";
import { NAV } from "$lib/nav";
import { setTheme } from "$lib/stores/theme";
import { authActions } from "$lib/stores/auth";
import { commandPalette } from "$lib/stores/command-palette";
import { goto } from "$app/navigation";
import { base } from "$app/paths";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon?: Component;
  keywords?: string[];
  run: () => void | Promise<void>;
}

export type CommandSource = (query: string) => PaletteCommand[] | Promise<PaletteCommand[]>;

const sources: CommandSource[] = [];

/** Register a dynamic command source. Returns an unregister function. */
export function registerCommandSource(source: CommandSource): () => void {
  sources.push(source);
  return () => {
    const idx = sources.indexOf(source);
    if (idx >= 0) sources.splice(idx, 1);
  };
}

function navigateCommand(href: string, label: string, icon: Component): PaletteCommand {
  return {
    id: `nav:${href}`,
    label: `Go to ${label}`,
    group: "Navigation",
    icon,
    keywords: ["go", "navigate", "open", label.toLowerCase()],
    run() {
      void goto(`${base}${href}`);
      commandPalette.close();
    },
  };
}

const ICON_MAP: Record<string, Component> = {
  Dashboard: LayoutDashboard,
  Hosts: Server,
  Projects: FolderKanban,
  "API Keys": KeyRound,
  Authoring: BookOpen,
  Logs: ScrollText,
  Users: Users,
  Integrations: Plug,
  Settings: Settings,
};

export const STATIC_COMMANDS: PaletteCommand[] = [
  ...NAV.map((n) =>
    navigateCommand(n.href, n.label, ICON_MAP[n.label] ?? LayoutDashboard),
  ),
  {
    id: "theme:light",
    label: "Switch theme: Light",
    group: "Theme",
    icon: Sun,
    keywords: ["theme", "light", "appearance"],
    run() {
      setTheme("light");
      commandPalette.close();
    },
  },
  {
    id: "theme:dark",
    label: "Switch theme: Dark",
    group: "Theme",
    icon: Moon,
    keywords: ["theme", "dark", "appearance"],
    run() {
      setTheme("dark");
      commandPalette.close();
    },
  },
  {
    id: "theme:system",
    label: "Switch theme: System",
    group: "Theme",
    icon: Monitor,
    keywords: ["theme", "system", "auto", "appearance"],
    run() {
      setTheme("system");
      commandPalette.close();
    },
  },
  {
    id: "help:shortcuts",
    label: "Open keyboard shortcuts",
    hint: "?",
    group: "Help",
    icon: Keyboard,
    keywords: ["shortcuts", "help", "keys"],
    run() {
      window.dispatchEvent(new CustomEvent("codex:open-shortcuts"));
      commandPalette.close();
    },
  },
  {
    id: "auth:logout",
    label: "Sign out",
    group: "Account",
    icon: LogOut,
    keywords: ["logout", "sign out", "exit"],
    async run() {
      await authActions.logout();
      commandPalette.close();
      void goto(`${base}/login`);
    },
  },
];

/** Collect all current commands (static + dynamic) for a search query. */
export async function collectCommands(query: string): Promise<PaletteCommand[]> {
  const dynamic = await Promise.all(sources.map((src) => src(query)));
  return [...STATIC_COMMANDS, ...dynamic.flat()];
}
