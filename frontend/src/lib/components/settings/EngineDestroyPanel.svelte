<script lang="ts">
  /**
   * Danger zone of the engine master switches: remove a suspended engine from
   * every host (config, binaries, homes, credentials), watch the per-host
   * progress, then purge the stored credentials and accounts on the server.
   * Irreversible for native credentials and history on the hosts.
   */
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { engineDestroyMutation, engineDestroyQuery } from "$lib/api/settings";
  import { ENGINE_META, type Engine } from "$lib/constants/engines";

  type Props = { engine: Engine; suspended: boolean; canMutate: boolean };
  let { engine, suspended, canMutate }: Props = $props();

  // The parent keys each panel by engine, so the prop never changes.
  // svelte-ignore state_referenced_locally
  const query = engineDestroyQuery(engine);
  const mutation = engineDestroyMutation({
    onSuccess: (_d, v) => toast.success(`${ENGINE_META[engine].label}: ${v.action} done`),
    onError: (e) => toast.error(e.message),
  });
  let typed = $state("");
  const progress = $derived($query.data);
  const open = $derived(progress?.request != null);
  const unfinished = $derived(
    progress ? progress.counts.pending + progress.counts.running + progress.counts.failed : 0,
  );
</script>

<div class="rounded-md border border-destructive/40 p-3 text-sm space-y-2">
  <div class="font-medium">Destroy {ENGINE_META[engine].label} on all hosts</div>
  {#if !open}
    <p class="text-xs text-muted-foreground">
      Removes the signed config, binaries, shims, aliases, home directories and credentials from every host
      that carries the engine. Requires the engine to be off. Irreversible.
    </p>
    <div class="flex gap-2 items-center">
      <Input class="max-w-48" placeholder={`type "${engine}"`} bind:value={typed} disabled={!suspended || !canMutate} />
      <Button
        variant="destructive"
        size="sm"
        disabled={!suspended || !canMutate || typed !== engine || $mutation.isPending}
        onclick={() => $mutation.mutate({ engine, action: "request" })}
      >Destroy</Button>
    </div>
    {#if !suspended}<p class="text-xs text-muted-foreground">Turn the engine off first.</p>{/if}
  {:else if progress}
    <p class="text-xs">
      Requested {progress.request?.requested_at}{progress.request?.requested_by ? ` by ${progress.request.requested_by}` : ""} ·
      {progress.counts.done} done · {progress.counts.running} running · {progress.counts.pending} pending · {progress.counts.failed} failed
    </p>
    <ul class="text-xs space-y-0.5">
      {#each progress.hosts as h (h.host_id)}
        <li>
          <span class="font-mono">{h.fqdn}</span> — {h.status}{h.residue.length ? `: ${h.residue.join("; ")}` : ""}
        </li>
      {/each}
    </ul>
    <div class="flex gap-2">
      <Button size="sm" variant="destructive" disabled={!canMutate || $mutation.isPending}
        onclick={() => $mutation.mutate({ engine, action: "purge", force: unfinished > 0 })}>
        {unfinished > 0 ? "Force purge server data" : "Purge server data"}
      </Button>
      <Button size="sm" variant="outline" disabled={!canMutate || $mutation.isPending}
        onclick={() => $mutation.mutate({ engine, action: "cancel" })}>Cancel request</Button>
    </div>
  {/if}
</div>
