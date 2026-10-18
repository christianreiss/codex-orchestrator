<script lang="ts">
  import { relativeTime } from "$lib/utils/format";
  let { value }: { value: Date | string | number | null | undefined } = $props();
  const date = $derived(value == null || value === "" ? null : value instanceof Date ? value : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value));
  const exact = $derived(date && !Number.isNaN(date.getTime()) ? date.toISOString() : null);
  const relative = $derived(exact ? relativeTime(value) : "Unknown time");
</script>
{#if exact}<time datetime={exact} title={`${exact} (UTC)`} aria-label={`${relative}; ${exact} UTC`}>{relative}</time>{:else}<span>Unknown time</span>{/if}
