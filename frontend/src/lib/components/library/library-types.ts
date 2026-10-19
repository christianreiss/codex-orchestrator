/**
 * The Library's content types. Four of them (skills, subagents, commands,
 * reply styles) are plain named documents and share one list and one editor;
 * agent rules and memories have their own screens but live on the same type
 * switch.
 */
import type { Component } from "svelte";
import Layers from "@lucide/svelte/icons/layers";
import Bot from "@lucide/svelte/icons/bot";
import SquareTerminal from "@lucide/svelte/icons/square-terminal";
import Palette from "@lucide/svelte/icons/palette";
import Brain from "@lucide/svelte/icons/brain";
import ScrollText from "@lucide/svelte/icons/scroll-text";
import UserCog from "@lucide/svelte/icons/user-cog";
import { skillsApi } from "$lib/api/skills";
import { subagentsApi, subagentsKeys } from "$lib/api/subagents";
import { commandsApi, commandsKeys } from "$lib/api/commands";
import { outputStylesApi, outputStylesKeys } from "$lib/api/outputStyles";
import type { ClaudeArtifactApi } from "$lib/api/claudeArtifacts";
import type { ArtifactView, SkillRow } from "$lib/api/types";

export type DocTypeId = "skills" | "subagents" | "commands" | "output-styles";
export type LibraryTypeId = DocTypeId | "agent-rules" | "memories" | "roles";

export const DOC_TYPE_IDS: readonly DocTypeId[] = ["skills", "subagents", "commands", "output-styles"];
export const ARTIFACT_TYPE_IDS = ["subagents", "commands", "output-styles"] as const;
export type ArtifactTypeId = (typeof ARTIFACT_TYPE_IDS)[number];

export function isDocType(value: string | null | undefined): value is DocTypeId {
  return !!value && (DOC_TYPE_IDS as readonly string[]).includes(value);
}
export function isArtifactType(value: string | null | undefined): value is ArtifactTypeId {
  return !!value && (ARTIFACT_TYPE_IDS as readonly string[]).includes(value);
}

/** One entry on the type switch. `href` is where the chip goes. */
export type LibraryTypeMeta = {
  id: LibraryTypeId;
  /** Plain label shown on the chip and in the page description. */
  label: string;
  /** The canonical term, kept as helper text. */
  canonical?: string;
  /** One line under the page title. */
  description: string;
  /** Claude-native content has no Codex or Grok counterpart. */
  claudeOnly: boolean;
  icon: Component;
};

const CLAUDE_ONLY_NOTE = "Claude-only: synced to Claude Code hosts, ignored by Codex and Grok.";

export const LIBRARY_TYPES: readonly LibraryTypeMeta[] = [
  {
    id: "skills", label: "Skills", icon: Layers, claudeOnly: false,
    description: "Reusable step-by-step procedures agents can invoke by name.",
  },
  {
    id: "agent-rules", label: "Agent rules", canonical: "fleet instructions · AGENTS.md", icon: ScrollText, claudeOnly: false,
    description: "The instructions every agent in the fleet starts from.",
  },
  {
    id: "roles", label: "Roles", canonical: "agent roles", icon: UserCog, claudeOnly: false,
    description: "Specialist responsibilities agents take on assignment, such as design review. Agents improve them; you steer.",
  },
  {
    id: "memories", label: "Memories", icon: Brain, claudeOnly: false,
    description: "Durable notes agents keep across sessions, by fleet, project and host.",
  },
  {
    id: "subagents", label: "Subagents", icon: Bot, claudeOnly: true,
    description: `Focused assistants Claude can delegate to. ${CLAUDE_ONLY_NOTE}`,
  },
  {
    id: "commands", label: "Commands", canonical: "slash commands", icon: SquareTerminal, claudeOnly: true,
    description: `Reusable slash-command prompts. ${CLAUDE_ONLY_NOTE}`,
  },
  {
    id: "output-styles", label: "Reply styles", canonical: "output styles", icon: Palette, claudeOnly: true,
    description: `How Claude formats and phrases its replies. ${CLAUDE_ONLY_NOTE}`,
  },
];

export function libraryTypeMeta(id: LibraryTypeId): LibraryTypeMeta {
  return LIBRARY_TYPES.find((entry) => entry.id === id) ?? LIBRARY_TYPES[0]!;
}

export function parseLibraryType(value: string | null | undefined): LibraryTypeId {
  return LIBRARY_TYPES.some((entry) => entry.id === value) ? (value as LibraryTypeId) : "skills";
}

export function libraryListHref(type: LibraryTypeId): string {
  if (type === "agent-rules") return "/library/agent-rules";
  return type === "skills" ? "/library" : `/library?type=${type}`;
}

export function libraryRoleHref(slug: string): string {
  return `/library/roles/${encodeURIComponent(slug)}`;
}

export function libraryDocHref(type: DocTypeId, slug: string): string {
  return `/library/${type}/${encodeURIComponent(slug)}`;
}

// ---- list configuration -----------------------------------------------------

export type StatusBadge = { label: string; variant: "success" | "destructive" | "secondary" | "warning" };

/** What the shared list shows for one document, whatever API it came from. */
export type LibraryRow = {
  slug: string;
  name: string;
  description: string | null;
  status: StatusBadge;
  updatedAt: string | null;
  /** Managed or synchronized rows cannot be deleted from the console. */
  locked: boolean;
};

export type CreateInput = { slug: string; name: string; description: string };

export type DocListConfig = {
  id: DocTypeId;
  /** "skill", "subagent", "reply style": used in buttons, toasts and dialogs. */
  singular: string;
  /** Skills carry a display name distinct from the slug at creation time. */
  hasDisplayName: boolean;
  slugPlaceholder: string;
  descriptionPlaceholder: string;
  emptyDescription: string;
  /** Query key of the list, and the prefix that invalidates list and details. */
  listKey: readonly string[];
  invalidateKey: readonly string[];
  load: () => Promise<LibraryRow[]>;
  create: (input: CreateInput) => Promise<{ slug: string }>;
  remove: (slug: string) => Promise<unknown>;
  deleteNote: string;
};

function skillStatus(row: SkillRow): StatusBadge {
  if (row.deleted_at) return { label: "deleted", variant: "destructive" };
  if (row.source_type?.trim()) {
    return { label: row.source_type.toLowerCase().includes("mattpocock") ? "Matt Pocock" : row.source_type, variant: "secondary" };
  }
  if (row.managed) return { label: "managed", variant: "secondary" };
  if (row.status && row.status !== "ok") return { label: row.status, variant: "warning" };
  return { label: "active", variant: "success" };
}

function skillManifest({ slug, name, description }: CreateInput): string {
  const title = name || slug;
  const desc = description || "Describe when this skill should be invoked.";
  return `---\nname: ${title}\ndescription: ${desc}\n---\n\n# ${title}\n\n## When to use\n\n${desc}\n\n## Steps\n\n1. ...\n`;
}

function artifactRow(row: ArtifactView): LibraryRow {
  return {
    slug: row.slug,
    name: row.display_name || row.slug,
    description: row.description,
    status: row.deleted_at ? { label: "deleted", variant: "destructive" } : { label: "active", variant: "success" },
    updatedAt: row.updated_at ?? null,
    locked: false,
  };
}

function artifactConfig(
  id: ArtifactTypeId,
  api: ClaudeArtifactApi,
  keys: { all: readonly string[]; list: () => readonly string[] },
  text: Pick<DocListConfig, "singular" | "slugPlaceholder" | "descriptionPlaceholder" | "emptyDescription">,
): DocListConfig {
  return {
    id,
    ...text,
    hasDisplayName: false,
    listKey: keys.list(),
    invalidateKey: keys.all,
    load: async () => (await api.list()).artifacts.map(artifactRow),
    create: ({ slug, description }) => api.store({ slug, description, body: "" }),
    remove: (slug) => api.delete(slug),
    deleteNote: `This removes the ${text.singular} from the fleet. You can re-create it with the same slug later.`,
  };
}

export const DOC_LISTS: Record<DocTypeId, DocListConfig> = {
  skills: {
    id: "skills",
    singular: "skill",
    hasDisplayName: true,
    slugPlaceholder: "e.g. project-coordination",
    descriptionPlaceholder: "When this skill should be invoked…",
    emptyDescription: "Skills give agents reusable step-by-step procedures they can invoke by name.",
    listKey: ["skills"],
    invalidateKey: ["skills"],
    load: async () =>
      (await skillsApi.list()).skills.map((row) => ({
        slug: row.slug,
        name: row.display_name || row.slug,
        description: row.description ?? null,
        status: skillStatus(row),
        updatedAt: row.updated_at ?? null,
        locked: !!row.managed || !!row.source_type?.trim(),
      })),
    create: (input) =>
      skillsApi.store({ slug: input.slug, display_name: input.name, description: input.description, manifest: skillManifest(input) }),
    remove: (slug) => skillsApi.delete(slug),
    deleteNote: "This soft-deletes the skill. You can re-create it with the same slug later.",
  },
  subagents: artifactConfig("subagents", subagentsApi, subagentsKeys, {
    singular: "subagent",
    slugPlaceholder: "e.g. code-reviewer",
    descriptionPlaceholder: "When this subagent should be invoked…",
    emptyDescription: "Subagents are focused, reusable assistants Claude can delegate to. Create one to get started.",
  }),
  commands: artifactConfig("commands", commandsApi, commandsKeys, {
    singular: "command",
    slugPlaceholder: "e.g. review",
    descriptionPlaceholder: "What this command does…",
    emptyDescription: "Commands are reusable slash-command prompts Claude can run on demand.",
  }),
  "output-styles": artifactConfig("output-styles", outputStylesApi, outputStylesKeys, {
    singular: "reply style",
    slugPlaceholder: "e.g. concise",
    descriptionPlaceholder: "What this reply style changes…",
    emptyDescription: "Reply styles change how Claude formats and phrases its responses.",
  }),
};

/** API + query keys for the three Claude-native document types. */
export const ARTIFACT_APIS: Record<ArtifactTypeId, { api: ClaudeArtifactApi; keys: typeof subagentsKeys }> = {
  subagents: { api: subagentsApi, keys: subagentsKeys },
  commands: { api: commandsApi, keys: commandsKeys },
  "output-styles": { api: outputStylesApi, keys: outputStylesKeys },
};
