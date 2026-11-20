<script lang="ts">
  /** A filter select ("All statuses" + options) on the shared Select. */
  import { SimpleSelect } from "$lib/components/ui/select";
  import { humanize } from "./report-model";

  type Props = { label: string; value: string; options: readonly string[]; allLabel: string };
  let { label, value = $bindable(), options, allLabel }: Props = $props();
  const items = $derived([{ value: "", label: allLabel }, ...options.map((option) => ({ value: option, label: humanize(option).replace(/^./, (c) => c.toUpperCase()) }))]);
</script>

<SimpleSelect aria-label={label} bind:value options={items} class="w-40" />
