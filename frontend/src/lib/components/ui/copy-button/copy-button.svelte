<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { toast } from "svelte-sonner";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
  import { Button, type ButtonSize, type ButtonVariant } from "$lib/components/ui/button";

  type Props = {
    /** Text copied to the clipboard when the button is clicked. */
    value: string;
    /** Optional visible label shown next to the icon (omit for icon-only). */
    label?: string;
    /** Label shown instead of `label` while the "copied" state is active. */
    copiedLabel?: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    class?: string;
    /** Success toast message shown after a successful copy. */
    toastMessage?: string;
  } & Omit<HTMLButtonAttributes, "class" | "onclick">;

  let {
    value,
    label,
    copiedLabel,
    variant = "outline",
    size = "default",
    class: className,
    toastMessage = "Copied to clipboard",
    ...rest
  }: Props = $props();

  let copied = $state(false);

  const currentLabel = $derived(copied ? (copiedLabel ?? label) : label);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      toast.success(toastMessage);
      setTimeout(() => (copied = false), 2000);
    } catch (err) {
      toast.error("Copy failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }
</script>

<Button
  type="button"
  {variant}
  {size}
  class={className}
  aria-label={label ?? "Copy"}
  onclick={copy}
  {...rest}
>
  {#if copied}
    <Check class="h-4 w-4 text-success" />
  {:else}
    <Copy class="h-4 w-4" />
  {/if}
  {#if currentLabel}{currentLabel}{/if}
</Button>
