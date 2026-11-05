<script lang="ts" module>
  /** What FormField hands its control: render these onto the input so hint/error stay bound to it. */
  export type FormFieldControl = { describedBy: string | undefined; invalid: true | undefined };
</script>

<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { Label } from "$lib/components/ui/label";
  import { cn } from "$lib/utils/cn";

  type Props = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
    id: string;
    label: string;
    hint?: string;
    error?: string;
    required?: boolean;
    children: Snippet<[FormFieldControl]>;
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

  // Only ids of text that is actually rendered below (error replaces hint).
  const control = $derived<FormFieldControl>({
    describedBy: error ? `${id}-error` : hint ? `${id}-hint` : undefined,
    invalid: error ? true : undefined,
  });
</script>

<!--
  Renders the hint/error text at id `${id}-hint` / `${id}-error`. The child snippet
  receives `{ describedBy, invalid }`; spread them onto the control with id `id`:
  `{#snippet children(f)}<Input {id} aria-describedby={f.describedBy} aria-invalid={f.invalid} />{/snippet}`.
-->
<div class={cn("space-y-1.5", className)} {...rest}>
  <Label for={id}>
    {label}
    {#if required}<span class="ml-0.5 text-destructive" aria-hidden="true">*</span>{/if}
  </Label>
  {@render children(control)}
  {#if error}
    <p id={`${id}-error`} class="text-body-sm text-destructive">{error}</p>
  {:else if hint}
    <p id={`${id}-hint`} class="text-body-sm text-muted-foreground">{hint}</p>
  {/if}
</div>
