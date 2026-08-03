<script lang="ts">
  /**
   * Discrete single-value slider over the bits-ui primitive.
   *
   * Steps are integers 0..max, so the thumb can only ever land on a real level
   * -- a security posture has no meaning between two bands. Tick marks make the
   * available positions visible rather than something you discover by dragging.
   *
   * Deliberately no colour ramp: the design spec reserves semantic colour for
   * real state, and a red-at-maximum track would editorialise a setting the
   * operator chose. Risk is communicated by the level's label and description.
   */
  import { Slider as SliderPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = {
    value: number;
    max?: number;
    disabled?: boolean;
    id?: string;
    "aria-label"?: string;
    class?: string;
    onValueChange: (value: number) => void;
  };

  let {
    value,
    max = 4,
    disabled = false,
    id,
    "aria-label": ariaLabel,
    class: className,
    onValueChange,
  }: Props = $props();

  const ticks = $derived(Array.from({ length: max + 1 }, (_, i) => i));
</script>

<SliderPrimitive.Root
  type="single"
  {id}
  {value}
  {disabled}
  min={0}
  {max}
  step={1}
  onValueChange={(next) => onValueChange(Number(next))}
  class={cn("relative flex w-full touch-none select-none items-center py-2", className)}
>
  <span class="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
    <SliderPrimitive.Range class="absolute h-full bg-primary" />
  </span>
  {#each ticks as tick (tick)}
    <SliderPrimitive.Tick
      index={tick}
      class="absolute size-1 -translate-x-1/2 rounded-full bg-border data-[bounded]:bg-primary-foreground/60"
    />
  {/each}
  <SliderPrimitive.Thumb
    index={0}
    aria-label={ariaLabel}
    class="block size-4 rounded-full border border-primary/50 bg-background shadow-none ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
  />
</SliderPrimitive.Root>
