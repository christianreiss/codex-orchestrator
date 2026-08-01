<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { Label } from "$lib/components/ui/label";
  import { cn } from "$lib/utils/cn";

  type Props = HTMLAttributes<HTMLDivElement> & {
    id: string;
    label: string;
    hint?: string;
    error?: string;
    required?: boolean;
    children: Snippet;
    class?: string;
  };

  let {
    id,
    label,
    hint,
    error,
    required = false,
    children,
    class: className,
    ...rest
  }: Props = $props();
</script>

<!--
  This component only renders the hint/error text at id `${id}-hint` / `${id}-error`.
  It does not control the child input's props, so the caller must wire
  `aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}` and
  `aria-invalid={error ? "true" : undefined}` onto their own input element.
-->
<div class={cn("space-y-1.5", className)} {...rest}>
  <Label for={id}>
    {label}
    {#if required}<span class="ml-0.5 text-destructive" aria-hidden="true">*</span>{/if}
  </Label>
  {@render children()}
  {#if error}
    <p id={`${id}-error`} class="text-xs text-destructive">{error}</p>
  {:else if hint}
    <p id={`${id}-hint`} class="text-xs text-muted-foreground">{hint}</p>
  {/if}
</div>
