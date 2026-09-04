<script lang="ts">
  let { label }: { label: string } = $props();
</script>

<div class="sticky top-1 z-10 my-3 flex justify-center">
  <span
    class="rounded-full border border-border bg-background/85 px-2.5 py-0.5 text-[11px] font-semibold
           uppercase tracking-[0.08em] text-muted-foreground backdrop-blur"
  >{label}</span>
</div>
