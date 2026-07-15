<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { cn } from "$lib/utils/cn";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import Fingerprint from "@lucide/svelte/icons/fingerprint";
  import Palette from "@lucide/svelte/icons/palette";

  const items = [
    { href: "/account/password", label: "Password", icon: KeyRound },
    { href: "/account/passkeys", label: "Passkeys", icon: Fingerprint },
    { href: "/account/theme", label: "Theme", icon: Palette },
  ];

  const path = $derived(page.url.pathname.replace(base, "") || "/");
</script>

<nav class="md:sticky md:top-24 md:self-start" aria-label="Account settings">
  <p class="mb-2 hidden px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground md:block">
    Account
  </p>
  <ul class="flex gap-1 overflow-x-auto rounded-xl border border-border/60 bg-card/70 p-1 md:flex-col md:gap-0.5 md:p-1.5">
    {#each items as item (item.href)}
      {@const Icon = item.icon}
      {@const active = path === item.href || path.startsWith(item.href + "/")}
      <li>
        <a
          href={`${base}${item.href}`}
          aria-current={active ? "page" : undefined}
          class={cn(
            "flex min-h-10 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-all",
            active
              ? "bg-accent text-accent-foreground shadow-sm"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon class="h-4 w-4" />
          <span>{item.label}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>
