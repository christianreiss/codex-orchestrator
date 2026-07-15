<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { cn } from "$lib/utils/cn";
  import Bot from "@lucide/svelte/icons/bot";
  import Brain from "@lucide/svelte/icons/brain";
  import FileText from "@lucide/svelte/icons/file-text";
  import Layers from "@lucide/svelte/icons/layers";
  import Palette from "@lucide/svelte/icons/palette";
  import Terminal from "@lucide/svelte/icons/terminal";

  let { children }: { children?: Snippet } = $props();

  const path = $derived(page.url.pathname.replace(base, "") || "/");

  const SHARED_TABS = [
    {
      href: "/authoring",
      label: "Skills",
      icon: Layers,
      match: (value: string) => value === "/authoring" || value.startsWith("/authoring/skills"),
    },
    {
      href: "/authoring/agents",
      label: "Agents",
      icon: FileText,
      match: (value: string) => value.startsWith("/authoring/agents"),
    },
    {
      href: "/authoring/memories",
      label: "Memories",
      icon: Brain,
      match: (value: string) => value.startsWith("/authoring/memories"),
    },
  ] as const;

  const CLAUDE_TABS = [
    {
      href: "/authoring/subagents",
      label: "Subagents",
      icon: Bot,
      match: (value: string) => value.startsWith("/authoring/subagents"),
    },
    {
      href: "/authoring/commands",
      label: "Commands",
      icon: Terminal,
      match: (value: string) => value.startsWith("/authoring/commands"),
    },
    {
      href: "/authoring/output-styles",
      label: "Output styles",
      icon: Palette,
      match: (value: string) => value.startsWith("/authoring/output-styles"),
    },
  ] as const;
</script>

{#snippet tabGroup(label: string, tabs: typeof SHARED_TABS | typeof CLAUDE_TABS)}
  <div class="min-w-0 flex-1">
    <p class="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {label}
    </p>
    <div class="flex min-w-0 gap-1 overflow-x-auto rounded-xl bg-muted/65 p-1">
      {#each tabs as tab (tab.href)}
        {@const Icon = tab.icon}
        {@const active = tab.match(path)}
        <a
          href={`${base}${tab.href}`}
          class={cn(
            "inline-flex min-h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            active
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-card/50 hover:text-foreground",
          )}
          aria-current={active ? "page" : undefined}
        >
          <Icon class="h-4 w-4" />
          {tab.label}
        </a>
      {/each}
    </div>
  </div>
{/snippet}

<PageHeader
  title="Authoring"
  subtitle="Manage shared fleet context and Claude-native extensions from one clearly scoped workspace."
/>

<nav
  class="mb-7 grid gap-3 rounded-2xl border border-border/70 bg-card/70 p-3 shadow-sm xl:grid-cols-2"
  aria-label="Authoring sections"
>
  {@render tabGroup("Shared across engines", SHARED_TABS)}
  {@render tabGroup("Claude-native", CLAUDE_TABS)}
</nav>

{@render children?.()}
