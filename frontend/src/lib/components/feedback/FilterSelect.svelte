<script lang="ts">
  /** A filter select ("All statuses" + options) on the shared Select. */
  import { SimpleSelect } from "$lib/components/ui/select";
  import { sentence } from "./report-model";

  type Props = { label: string; value: string; options: readonly string[]; allLabel: string };
  let { label, value = $bindable(), options, allLabel }: Props = $props();
  const items = $derived([{ value: "", label: allLabel }, ...options.map((option) => ({ value: option, label: sentence(option) }))]);
</script>

<SimpleSelect aria-label={label} bind:value options={items} class="w-40" />
