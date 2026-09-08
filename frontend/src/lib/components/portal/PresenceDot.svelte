<script lang="ts">
  import type { Presence } from "$lib/portal/types";

  // Shape carries the state as well as colour: the bug being fixed was two
  // different states both rendering as a green dot.
  let { presence, class: extra = "" }: { presence: Presence; class?: string } = $props();
</script>

<span class="presence-dot presence-dot--{presence} {extra}" aria-hidden="true"></span>

<style>
  /* Shared by /admin and /go; status must not depend on portal-only CSS. */
  .presence-dot { position: relative; display: inline-block; flex: none; width: .5rem; height: .5rem; border-radius: 9999px; background: hsl(var(--muted-foreground)); }
  .presence-dot--listening { background: hsl(var(--success)); box-shadow: 0 0 0 2px hsl(var(--success) / .18); }
  .presence-dot--working { background: hsl(var(--success) / .25); border: 1.5px solid hsl(var(--success)); overflow: hidden; }
  .presence-dot--working::after { content: ""; position: absolute; inset: 0; background: hsl(var(--success)); clip-path: inset(0 0 0 50%); }
  .presence-dot--idle { background: transparent; border: 1.5px solid hsl(var(--warning)); }
  .presence-dot--offline { background: hsl(var(--muted-foreground) / .5); }
  .presence-dot--offline::after { content: ""; position: absolute; left: 50%; top: 50%; width: 12px; height: 1.5px; background: hsl(var(--muted-foreground)); transform: translate(-50%, -50%) rotate(-45deg); }
  .presence-dot--ended { border-radius: 1px; background: hsl(var(--muted-foreground) / .6); }
</style>
