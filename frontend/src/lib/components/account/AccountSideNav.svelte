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

<nav aria-label="Account settings" class="border-b border-border">
  <ul class="flex -mb-px overflow-x-auto">
    {#each items as item (item.href)}
      {@const Icon = item.icon}
      {@const active = path === item.href || path.startsWith(item.href + "/")}
      <li>
        <a
          href={`${base}${item.href}`}
          aria-current={active ? "page" : undefined}
          class={cn(
            "flex min-h-11 items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium transition-colors sm:min-h-9",
            active
              ? "border-primary text-foreground"
              : "text-muted-foreground hover:border-border hover:text-foreground",
          )}
        >
          <Icon class="h-4 w-4" />
          <span>{item.label}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>
