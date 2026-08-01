<script lang="ts">
  import { cn } from "$lib/utils/cn";

  let {
    class: className,
    status = false,
  }: {
    class?: string;
    status?: boolean;
  } = $props();
</script>

<!--
  Switchyard: one canonical source forks into the Codex and Claude personas.
  Keep the path/circle geometry aligned with static/favicon.svg and
  public/admin/error-logo.svg; brand-mark.test.ts pins the shared silhouette.
-->
<span
  data-brand-mark="switchyard"
  class={cn(
    "relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-[hsl(var(--sidebar-bg))] text-white",
    className,
  )}
  aria-hidden="true"
>
  <svg viewBox="0 0 32 32" class="h-full w-full" fill="none" focusable="false">
    <path
      d="M9 16h4.25c2.9 0 3.55-6 6.5-6H23"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M13.25 16c2.9 0 3.55 6 6.5 6H23"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path d="M9 12.8 12.2 16 9 19.2 5.8 16Z" fill="currentColor" />
    <circle cx="24" cy="10" r="2.35" fill="#67e8f9" stroke="currentColor" stroke-width="0.8" />
    <circle cx="24" cy="22" r="2.35" fill="#fdba74" stroke="currentColor" stroke-width="0.8" />
  </svg>

  {#if status}
    <span
      class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[hsl(var(--sidebar-bg))] bg-success"
    ></span>
  {/if}
</span>
