<script lang="ts">
  /** A native filter select ("All statuses" + options). Native so it works on every device and with `selectOption`. */
  import { filterClass, humanize } from "./report-model";

  type Props = { label: string; value: string; options: readonly string[]; allLabel: string };
  let { label, value = $bindable(), options, allLabel }: Props = $props();
</script>

<select aria-label={label} class="{filterClass} w-40" bind:value>
  <option value="">{allLabel}</option>
  {#each options as option (option)}<option value={option}>{humanize(option)}</option>{/each}
</select>
