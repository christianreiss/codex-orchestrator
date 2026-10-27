<script lang="ts">
  import { Switch as SwitchPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = SwitchPrimitive.RootProps;
  let { class: className, ...rest }: Props = $props();
</script>

<SwitchPrimitive.Root
  class={cn(
    "peer group inline-flex h-6 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...rest}
>
  <!-- Keep the track stable when the button's touch target grows. -->
  <span aria-hidden="true" class="pointer-events-none inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent bg-input transition-colors group-data-[state=checked]:bg-primary">
    <SwitchPrimitive.Thumb
      class="block h-5 w-5 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
    />
  </span>
</SwitchPrimitive.Root>
