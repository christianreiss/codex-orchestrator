<script lang="ts">
  import { tick } from "svelte";
  import { useSvelteFlow } from "@xyflow/svelte";

  type Props = {
    topologyKey: string;
    reducedMotion: boolean;
  };

  let { topologyKey, reducedMotion }: Props = $props();
  const { fitView } = useSvelteFlow();

  $effect(() => {
    topologyKey;
    let cancelled = false;

    void tick().then(() => {
      if (cancelled) return;
      void fitView({
        padding: 0.18,
        minZoom: 0.18,
        maxZoom: 1.15,
        duration: reducedMotion ? 0 : 350,
      });
    });

    return () => {
      cancelled = true;
    };
  });
</script>
