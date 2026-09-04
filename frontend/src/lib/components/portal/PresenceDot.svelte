<script lang="ts">
  import type { Presence } from "$lib/portal/types";

  // Shape carries the state as well as colour: the bug being fixed was two
  // different states both rendering as a green dot.
  let { presence, class: extra = "" }: { presence: Presence; class?: string } = $props();
</script>

<span class="presence-dot presence-dot--{presence} {extra}" aria-hidden="true"></span>
