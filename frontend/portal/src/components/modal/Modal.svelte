<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * A native <dialog>, deliberately not bits-ui.
   *
   * bits-ui releases its body scroll lock with setAttribute("style", ...),
   * which this page's CSP blocks. The attribute clears but the declaration
   * block stays applied, so after the first dialog closes <body> keeps
   * `pointer-events: none` and the whole portal stops responding to clicks.
   *
   * showModal() also gives us a focus trap, Escape, focus restore and
   * ::backdrop for free.
   */
  let {
    open = $bindable(false),
    labelledBy,
    children,
  }: { open?: boolean; labelledBy: string; children: Snippet } = $props();

  let node = $state<HTMLDialogElement | null>(null);

  $effect(() => {
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  });
</script>

<dialog
  bind:this={node}
  class="portal-dialog"
  aria-labelledby={labelledBy}
  onclose={() => (open = false)}
  oncancel={() => (open = false)}
>
  {#if open}{@render children()}{/if}
</dialog>
