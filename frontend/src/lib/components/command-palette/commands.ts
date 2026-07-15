/**
 * Cmd-K command registry.
 *
 * The palette renders commands organised into the following groups, in
 * order: Recent, Hosts, Navigation, Actions, Projects, Skills, Users,
 * Theme & session.
 *
 * Static commands (navigation, deep links, actions, theme, sign out) are
 * declared inline below. Dynamic command sources (host/project/skill/user
 * jump-to results) are produced by `buildDynamicSources()` against a
 * svelte-query `QueryClient` so the palette stays interactive while the
 * sources resolve, and lists are cached between opens.
 */
import type { Component } from "svelte";
import type { QueryClient } from "@tanstack/svelte-query";
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
  Plus,
  Zap,
  FileText,
  Lock,
  Fingerprint,
  HelpCircle,
  Activity,
  Layers,
  GitBranch,
  Brain,
  UserCircle,
} from "@lucide/svelte";
import { NAV } from "$lib/nav";
import { setTheme } from "$lib/stores/theme";
import { authActions } from "$lib/stores/auth";
import { commandPalette } from "$lib/stores/command-palette";
import { goto } from "$app/navigation";
import { base } from "$app/paths";
import {
  fetchHosts,
  fetchProjects,
  fetchSkills,
  fetchUsers,
  quickSearchKeys,
  type QuickHost,
  type QuickProject,
  type QuickSkill,
  type QuickUser,
} from "$lib/api/quicksearch";

export const COMMAND_GROUPS = [
  "Recent",
  "Hosts",
  "Navigation",
  "Actions",
  "Projects",
  "Skills",
  "Users",
  "Theme & session",
] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group: CommandGroup;
  icon?: Component;
  keywords?: string[];
  run: () => void | Promise<void>;
}

/** A dynamic command source. Returns commands for the given query string. */
export type CommandSource = (query: string) => PaletteCommand[] | Promise<PaletteCommand[]>;

const externalSources: CommandSource[] = [];

/* -------------------------------------------------------------------------- */
/*  Static commands                                                            */
/* -------------------------------------------------------------------------- */

function navigateCommand(
  href: string,
  label: string,
  icon: Component,
  extraKeywords: string[] = [],
): PaletteCommand {
  return {
    id: `nav:${href}`,
    label: `Go to ${label}`,
    group: "Navigation",
    icon,
    keywords: ["go", "navigate", "open", label.toLowerCase(), ...extraKeywords],
    run() {
      void goto(`${base}${href}`);
      commandPalette.close();
    },
  };
}

const NAV_ICON_MAP: Record<string, Component> = {
  Overview: LayoutDashboard,
  Hosts: Server,
  Projects: FolderKanban,
  "API access": KeyRound,
  Authoring: BookOpen,
  Activity: Activity,
  Users: Users,
  Integrations: Plug,
  Settings: Settings,
};

/** Deep-link navigation entries (in addition to top-level NAV). */
const DEEP_NAV: Array<{ href: string; label: string; icon: Component; keywords?: string[] }> = [
  {
    href: "/logs/mcp",
    label: "Activity / MCP requests",
    icon: ScrollText,
    keywords: ["logs", "mcp"],
  },
  {
    href: "/logs/events",
    label: "Activity / Audit trail",
    icon: ScrollText,
    keywords: ["logs", "events", "audit", "trail"],
  },
  {
    href: "/authoring",
    label: "Authoring / Skills",
    icon: Layers,
    keywords: ["skills", "skill"],
  },
  {
    href: "/authoring/agents",
    label: "Authoring / Agents",
    icon: GitBranch,
    keywords: ["agents", "agents.md"],
  },
  {
    href: "/authoring/memories",
    label: "Authoring / Memories",
    icon: Brain,
    keywords: ["memories", "memory"],
  },
  {
    href: "/account/password",
    label: "Account / Password",
    icon: Lock,
    keywords: ["password", "account", "security"],
  },
  {
    href: "/account/passkeys",
    label: "Account / Passkeys",
    icon: Fingerprint,
    keywords: ["passkeys", "webauthn", "account"],
  },
  {
    href: "/settings?tab=general",
    label: "Settings / General",
    icon: Settings,
    keywords: ["settings", "general", "config", "configuration"],
  },
  {
    href: "/settings?tab=codex",
    label: "Settings / Codex",
    icon: Settings,
    keywords: ["settings", "codex", "openai", "config", "configuration"],
  },
  {
    href: "/settings?tab=claude",
    label: "Settings / Claude",
    icon: Settings,
    keywords: ["settings", "claude", "anthropic", "config", "configuration"],
  },
  {
    href: "/settings/users",
    label: "Settings / Users",
    icon: Users,
    keywords: ["users", "accounts", "roles", "settings"],
  },
  {
    href: "/manual",
    label: "Manual",
    icon: HelpCircle,
    keywords: ["manual", "help", "docs", "documentation"],
  },
];

function buildNavigationCommands(): PaletteCommand[] {
  const cmds: PaletteCommand[] = [];
  for (const n of NAV) {
    cmds.push(navigateCommand(n.href, n.label, NAV_ICON_MAP[n.label] ?? LayoutDashboard));
  }
  for (const d of DEEP_NAV) {
    cmds.push({
      id: `nav:${d.href}#${d.label}`,
      label: `Go to ${d.label}`,
      group: "Navigation",
      icon: d.icon,
      keywords: ["go", "navigate", "open", d.label.toLowerCase(), ...(d.keywords ?? [])],
      run() {
        void goto(`${base}${d.href}`);
        commandPalette.close();
      },
    });
  }
  return cmds;
}

function buildActionCommands(): PaletteCommand[] {
  return [
    {
      id: "action:new-host",
      label: "New host",
      group: "Actions",
      icon: Plus,
      keywords: ["host", "add", "register", "create"],
      run() {
        void goto(`${base}/hosts?dialog=new-host`);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("codex:open-new-host"));
        }
        commandPalette.close();
      },
    },
    {
      id: "action:quick-vm",
      label: "Quick VM",
      group: "Actions",
      icon: Zap,
      keywords: ["vm", "quick", "temporary", "host"],
      run() {
        // The /hosts route listens for either the query string or this event.
        void goto(`${base}/hosts?dialog=quick-vm`);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("codex:open-quick-vm"));
        }
        commandPalette.close();
      },
    },
    {
      id: "action:new-project",
      label: "New project",
      group: "Actions",
      icon: Plus,
      keywords: ["project", "create", "new"],
      run() {
        void goto(`${base}/projects?dialog=new`);
        commandPalette.close();
      },
    },
    {
      id: "action:new-api-key",
      label: "New API key",
      group: "Actions",
      icon: Plus,
      keywords: ["api", "key", "openai", "claude", "create"],
      run() {
        void goto(`${base}/api-keys?dialog=new`);
        commandPalette.close();
      },
    },
    {
      id: "action:open-shortcuts",
      label: "Open shortcuts",
      hint: "?",
      group: "Actions",
      icon: Keyboard,
      keywords: ["shortcuts", "help", "keys", "keyboard"],
      run() {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("codex:open-shortcuts"));
        }
        commandPalette.close();
      },
    },
    {
      id: "action:sign-out",
      label: "Sign out",
      group: "Actions",
      icon: LogOut,
      keywords: ["logout", "sign out", "exit"],
      async run() {
        commandPalette.close();
        await authActions.logout();
        void goto(`${base}/login`);
      },
    },
  ];
}

function buildThemeSessionCommands(): PaletteCommand[] {
  return [
    {
      id: "theme:light",
      label: "Switch to Light",
      group: "Theme & session",
      icon: Sun,
      keywords: ["theme", "light", "appearance"],
      run() {
        setTheme("light");
        commandPalette.close();
      },
    },
    {
      id: "theme:dark",
      label: "Switch to Dark",
      group: "Theme & session",
      icon: Moon,
      keywords: ["theme", "dark", "appearance"],
      run() {
        setTheme("dark");
        commandPalette.close();
      },
    },
    {
      id: "theme:system",
      label: "Switch to System",
      group: "Theme & session",
      icon: Monitor,
      keywords: ["theme", "system", "auto", "appearance"],
      run() {
        setTheme("system");
        commandPalette.close();
      },
    },
  ];
}

export const STATIC_COMMANDS: PaletteCommand[] = [
  ...buildNavigationCommands(),
  ...buildActionCommands(),
  ...buildThemeSessionCommands(),
];

/**
 * Build "Recent" group entries from a list of previously-invoked static
 * command ids (most recent first). Each entry is a shallow copy of the
 * matching `STATIC_COMMANDS` entry with its group overridden to "Recent"
 * and its id prefixed so cmdk doesn't see a duplicate id alongside the
 * original entry in its own group. Ids with no matching static command
 * (stale/renamed) are dropped.
 */
export function buildRecentCommands(ids: string[]): PaletteCommand[] {
  const byId = new Map(STATIC_COMMANDS.map((cmd) => [cmd.id, cmd]));
  const recents: PaletteCommand[] = [];
  for (const id of ids) {
    const cmd = byId.get(id);
    if (!cmd) continue;
    recents.push({ ...cmd, id: `recent:${cmd.id}`, group: "Recent" });
  }
  return recents;
}

/* -------------------------------------------------------------------------- */
/*  Dynamic command sources                                                    */
/* -------------------------------------------------------------------------- */

const QUICKSEARCH_STALE_MS = 60_000;

/** Lightweight client-side fuzzy: case-insensitive substring across any term. */
function matches(haystack: Array<string | null | undefined>, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  for (const h of haystack) {
    if (!h) continue;
    if (h.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function hostCommand(h: QuickHost): PaletteCommand {
  const tags: string[] = [];
  if (h.vip) tags.push("VIP");
  if (h.secure === false) tags.push("Insecure");
  const labelSuffix = tags.length ? ` · ${tags.join(" · ")}` : "";
  return {
    id: `host:${h.id}`,
    label: `${h.fqdn}${labelSuffix}`,
    group: "Hosts",
    icon: Server,
    keywords: ["host", h.fqdn.toLowerCase(), h.status ?? ""],
    run() {
      void goto(`${base}/hosts/${h.id}`);
      commandPalette.close();
    },
  };
}

function projectCommand(p: QuickProject): PaletteCommand {
  const label = p.title || p.name || p.slug;
  return {
    id: `project:${p.slug}`,
    label,
    group: "Projects",
    icon: FolderKanban,
    keywords: ["project", p.slug.toLowerCase(), (p.name ?? "").toLowerCase()],
    run() {
      void goto(`${base}/projects/${p.slug}`);
      commandPalette.close();
    },
  };
}

function skillCommand(s: QuickSkill): PaletteCommand {
  const label = s.display_name || s.name || s.slug;
  return {
    id: `skill:${s.slug}`,
    label,
    group: "Skills",
    icon: Activity,
    keywords: ["skill", s.slug.toLowerCase(), (s.name ?? "").toLowerCase()],
    run() {
      void goto(`${base}/authoring/skills/${s.slug}`);
      commandPalette.close();
    },
  };
}

function userCommand(u: QuickUser): PaletteCommand {
  const label = u.name ? `${u.name} (${u.username})` : u.username;
  return {
    id: `user:${u.id}`,
    label,
    group: "Users",
    icon: UserCircle,
    keywords: ["user", u.username.toLowerCase(), (u.name ?? "").toLowerCase(), (u.email ?? "").toLowerCase()],
    run() {
      void goto(`${base}/settings/users?user=${encodeURIComponent(String(u.id))}`);
      commandPalette.close();
    },
  };
}

/**
 * Build dynamic command sources bound to the given QueryClient. Lists are
 * fetched lazily via `fetchQuery`, cached across opens, and filtered
 * client-side by the current query string.
 *
 * Each source returns immediately if the data is cached; otherwise it
 * resolves once the underlying request completes. The palette must not
 * block its initial render on these — it should append results as they
 * arrive.
 */
export function buildDynamicSources(qc: QueryClient): CommandSource[] {
  const MAX = 12;
  const cap = <T>(arr: T[]) => arr.slice(0, MAX);

  const hostSource: CommandSource = async (query) => {
    const rows = await qc.fetchQuery({
      queryKey: quickSearchKeys.hosts,
      queryFn: fetchHosts,
      staleTime: QUICKSEARCH_STALE_MS,
    });
    const filtered = rows.filter((h) => matches([h.fqdn, h.status], query));
    return cap(filtered).map(hostCommand);
  };

  const projectSource: CommandSource = async (query) => {
    const rows = await qc.fetchQuery({
      queryKey: quickSearchKeys.projects,
      queryFn: fetchProjects,
      staleTime: QUICKSEARCH_STALE_MS,
    });
    const filtered = rows.filter((p) => matches([p.slug, p.name, p.title, p.description], query));
    return cap(filtered).map(projectCommand);
  };

  const skillSource: CommandSource = async (query) => {
    const rows = await qc.fetchQuery({
      queryKey: quickSearchKeys.skills,
      queryFn: fetchSkills,
      staleTime: QUICKSEARCH_STALE_MS,
    });
    const filtered = rows.filter((s) =>
      matches([s.slug, s.name, s.display_name, s.description], query),
    );
    return cap(filtered).map(skillCommand);
  };

  const userSource: CommandSource = async (query) => {
    const rows = await qc.fetchQuery({
      queryKey: quickSearchKeys.users,
      queryFn: fetchUsers,
      staleTime: QUICKSEARCH_STALE_MS,
    });
    const filtered = rows.filter((u) => matches([u.username, u.name, u.email], query));
    return cap(filtered).map(userCommand);
  };

  return [hostSource, projectSource, skillSource, userSource];
}

/** Snapshot of external sources for the palette to merge. */
export function getExternalSources(): readonly CommandSource[] {
  return externalSources;
}

/**
 * Ranked order for groups when rendering. The palette uses this to keep
 * sections consistent regardless of which dynamic source resolved first.
 */
export function groupOrder(group: CommandGroup): number {
  return COMMAND_GROUPS.indexOf(group);
}
