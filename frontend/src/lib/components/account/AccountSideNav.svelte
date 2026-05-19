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

<nav class="md:sticky md:top-6 md:self-start" aria-label="Account settings">
  <ul class="flex gap-1 overflow-x-auto md:flex-col md:gap-0.5">
    {#each items as item (item.href)}
      {@const Icon = item.icon}
      {@const active = path === item.href || path.startsWith(item.href + "/")}
      <li>
        <a
          href={`${base}${item.href}`}
          aria-current={active ? "page" : undefined}
          class={cn(
            "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors",
            active
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
          )}
        >
          <Icon class="h-4 w-4" />
          <span>{item.label}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>
