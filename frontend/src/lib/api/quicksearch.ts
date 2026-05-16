/**
 * Quick-search clients for the Cmd-K command palette.
 *
 * These fetchers hit the same admin listing endpoints used by the feature
 * pages — they only return enough shape to populate "jump to" results in
 * the palette. The caller is expected to cache responses via svelte-query
 * (see `CommandPalette.svelte`).
 */
import { api } from "./client";

export interface QuickHost {
  id: number;
  fqdn: string;
  status?: string | null;
  secure?: boolean;
  vip?: boolean;
}

export interface QuickProject {
  slug: string;
  name?: string | null;
  title?: string | null;
  description?: string | null;
}

export interface QuickSkill {
  slug: string;
  display_name?: string | null;
  name?: string | null;
  description?: string | null;
}

export interface QuickUser {
  id: number | string;
  username: string;
  name?: string | null;
  email?: string | null;
}

interface HostsEnvelope {
  hosts?: unknown[];
}
interface ProjectsEnvelope {
  projects?: unknown[];
}
interface SkillsEnvelope {
  skills?: unknown[];
}
interface UsersEnvelope {
  users?: unknown[];
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  return null;
}
function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return undefined;
}

export async function fetchHosts(): Promise<QuickHost[]> {
  const env = await api.get<HostsEnvelope>("/admin/hosts");
  const rows = Array.isArray(env?.hosts) ? env.hosts : [];
  const out: QuickHost[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = asNumber(row.id);
    const fqdn = asString(row.fqdn);
    if (id === null || !fqdn) continue;
    out.push({
      id,
      fqdn,
      status: asString(row.status),
      secure: asBool(row.secure),
      vip: asBool(row.vip),
    });
  }
  return out;
}

export async function fetchProjects(): Promise<QuickProject[]> {
  const env = await api.get<ProjectsEnvelope>("/admin/projects");
  const rows = Array.isArray(env?.projects) ? env.projects : [];
  const out: QuickProject[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const slug = asString(row.slug);
    if (!slug) continue;
    out.push({
      slug,
      name: asString(row.name),
      title: asString(row.title),
      description: asString(row.description),
    });
  }
  return out;
}

export async function fetchSkills(): Promise<QuickSkill[]> {
  const env = await api.get<SkillsEnvelope>("/admin/skills");
  const rows = Array.isArray(env?.skills) ? env.skills : [];
  const out: QuickSkill[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const slug = asString(row.slug);
    if (!slug) continue;
    out.push({
      slug,
      display_name: asString(row.display_name),
      name: asString(row.name),
      description: asString(row.description),
    });
  }
  return out;
}

export async function fetchUsers(): Promise<QuickUser[]> {
  const env = await api.get<UsersEnvelope>("/admin/users");
  const rows = Array.isArray(env?.users) ? env.users : [];
  const out: QuickUser[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const username = asString(row.username);
    const id = asNumber(row.id) ?? asString(row.id);
    if (id === null || !username) continue;
    out.push({
      id: id as number | string,
      username,
      name: asString(row.name),
      email: asString(row.email),
    });
  }
  return out;
}

/** Query keys for svelte-query caching. */
export const quickSearchKeys = {
  hosts: ["quicksearch", "hosts"] as const,
  projects: ["quicksearch", "projects"] as const,
  skills: ["quicksearch", "skills"] as const,
  users: ["quicksearch", "users"] as const,
};
