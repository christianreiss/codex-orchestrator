<script lang="ts">
  import { onDestroy } from "svelte";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";
  import { Input } from "$lib/components/ui/input";

  type Props = {
    value: string;
    placeholder?: string;
    onInput: (value: string) => void;
  };

  let { value = $bindable(), placeholder = "Search the manual…", onInput }: Props = $props();

  let timer: ReturnType<typeof setTimeout> | null = null;

  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    value = target.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      onInput(target.value);
    }, 150);
  }

  function clear() {
    value = "";
    if (timer) clearTimeout(timer);
    onInput("");
  }

  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });
</script>

<div class="relative">
  <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
  <Input
    type="search"
    {value}
    {placeholder}
    aria-label="Search the manual"
    oninput={handleInput}
    class="pl-9 pr-9"
  />
  {#if value}
    <button
      type="button"
      onclick={clear}
      aria-label="Clear search"
      class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <X class="h-3.5 w-3.5" />
    </button>
  {/if}
</div>
