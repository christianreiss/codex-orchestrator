<script lang="ts">
  /**
   * Two bounds on one track over the bits-ui primitive: a lower and an upper value that can
   * never cross (the primitive sorts them). Each thumb is its own `role="slider"` with a name
   * and value text; arrows move one step, Page Up/Down ten, Home/End to the ends.
   *
   * The track reads as three zones: solid up to the lower thumb, lighter between the thumbs,
   * plain beyond the upper one. Like the single slider, no colour ramp: the values are the
   * operator's choice, not a state (VIS-4). Scale labels sit under the track, and the
   * thumbs keep a 36 px hit area inside a 20 px dot (ACC-3).
   */
  import { Slider as SliderPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = {
    value: [number, number];
    min: number;
    max: number;
    step?: number;
    /** Accessible names of the lower and the upper thumb. */
    labels: [string, string];
    /** Value text of a thumb for assistive technology, e.g. `90%`. */
    format?: (value: number) => string;
    /** Values to label under the track. */
    scale?: number[];
    disabled?: boolean;
    class?: string;
    onValueChange: (value: [number, number]) => void;
  };

  let { value, min, max, step = 1, labels, format = String, scale = [], disabled = false, class: className, onValueChange }: Props = $props();

  const at = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100;
</script>

<div class={cn("grid gap-1.5 px-2.5", className)}>
  <SliderPrimitive.Root
    type="multiple"
    {value}
    {min}
    {max}
    {step}
    {disabled}
    thumbPositioning="exact"
    onValueChange={(next) => onValueChange([Number(next[0]), Number(next[1])])}
    class="relative flex w-full touch-none select-none items-center py-3 data-[disabled]:opacity-50"
  >
    <span class="relative h-2 w-full grow overflow-hidden rounded-full bg-muted">
      <span class="absolute inset-y-0 left-0 bg-primary" style:width={`${at(value[0])}%`}></span>
      <SliderPrimitive.Range class="absolute h-full bg-primary/35" />
    </span>
    {#each [0, 1] as index (index)}
      <SliderPrimitive.Thumb
        {index}
        aria-label={labels[index]}
        aria-valuetext={format(value[index]!)}
        class="relative block size-5 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors before:absolute before:-inset-2 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[disabled]:pointer-events-none"
      />
    {/each}
  </SliderPrimitive.Root>
  {#if scale.length}
    <div class="relative h-4 text-caption text-muted-foreground" aria-hidden="true">
      {#each scale as mark (mark)}
        <span
          class={cn("absolute top-0", mark <= min ? "" : mark >= max ? "-translate-x-full" : "-translate-x-1/2")}
          style:left={`${at(mark)}%`}
        >{format(mark)}</span>
      {/each}
    </div>
  {/if}
</div>
