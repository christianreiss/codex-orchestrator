<script lang="ts">
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  import { buttonVariants, type ButtonSize, type ButtonVariant } from "./index";

  type BaseProps = {
    variant?: ButtonVariant;
    size?: ButtonSize;
    class?: string;
    children?: Snippet;
  };

  type Props = BaseProps &
    (
      | ({ href: string } & Omit<HTMLAnchorAttributes, "href" | "class" | "children">)
      | ({ href?: undefined } & Omit<HTMLButtonAttributes, "class" | "children">)
    );

  let {
    variant = "default",
    size = "default",
    class: className,
    children,
    href,
    ...rest
  }: Props = $props();

  // Split rest into typed branches.
  const anchorRest = $derived(rest as Omit<HTMLAnchorAttributes, "href" | "class" | "children">);
  const buttonRest = $derived(rest as Omit<HTMLButtonAttributes, "class" | "children">);
</script>

{#if href}
  <a {href} class={cn(buttonVariants({ variant, size }), className)} {...anchorRest}>
    {@render children?.()}
  </a>
{:else}
  <button
    type={(buttonRest.type as "button" | "submit" | "reset" | undefined) ?? "button"}
    class={cn(buttonVariants({ variant, size }), className)}
    {...buttonRest}
  >
    {@render children?.()}
  </button>
{/if}
