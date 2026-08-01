<main class="grid h-full place-content-center">
  <div class="flex items-center gap-1.5" role="status" aria-label="Opening your fleet">
    {#each [0, 1, 2] as index (index)}
      <span
        class="h-2 w-2 animate-pulse rounded-full bg-primary"
        style:animation-delay="{index * 160}ms"
      ></span>
    {/each}
  </div>
</main>
