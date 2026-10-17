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
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
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
  let purgeOpen = $state(false);
  const progress = $derived($query.data);
  const open = $derived(progress?.request != null);
  const unfinished = $derived(
    progress ? progress.counts.pending + progress.counts.running + progress.counts.failed : 0,
  );
</script>

<div class="space-y-2 py-3 first:pt-0 last:pb-0">
  <div class="text-body font-medium">Remove {ENGINE_META[engine].label} from all hosts</div>
  {#if !open}
    <p class="text-body-sm text-muted-foreground">
      Removes the signed config, binaries, shims, aliases, home directories and credentials from every host
      that carries the engine. Requires the engine to be off. Irreversible.
    </p>
    <div class="flex items-center gap-2">
      <Input class="max-w-48" aria-label={`Type ${engine} to confirm`} placeholder={`type "${engine}"`} bind:value={typed} disabled={!suspended || !canMutate} />
      <Button
        variant="destructive"
        disabled={!suspended || !canMutate || typed !== engine || $mutation.isPending}
        onclick={() => $mutation.mutate({ engine, action: "request" })}
      >Destroy</Button>
    </div>
    {#if !suspended}<p class="text-caption text-muted-foreground">Turn the engine off first.</p>{/if}
  {:else if progress}
    <p class="text-body-sm">
      Requested {progress.request?.requested_at}{progress.request?.requested_by ? ` by ${progress.request.requested_by}` : ""} ·
      {progress.counts.done} done · {progress.counts.running} running · {progress.counts.pending} pending · {progress.counts.failed} failed
    </p>
    <ul class="space-y-0.5 text-body-sm">
      {#each progress.hosts as h (h.host_id)}
        <li>
          <span class="font-mono">{h.fqdn}</span> — {h.status}{h.residue.length ? `: ${h.residue.join("; ")}` : ""}
        </li>
      {/each}
    </ul>
    <div class="flex gap-2">
      <Button variant="outline" disabled={!canMutate || $mutation.isPending}
        onclick={() => $mutation.mutate({ engine, action: "cancel" })}>Cancel request</Button>
      <Button variant="destructive" disabled={!canMutate || $mutation.isPending} onclick={() => (purgeOpen = true)}>
        {unfinished > 0 ? "Force purge server data" : "Purge server data"}
      </Button>
    </div>
  {/if}
</div>

<ConfirmDialog
  bind:open={purgeOpen}
  title={`${unfinished > 0 ? "Force purge" : "Purge"} ${ENGINE_META[engine].label} server data?`}
  description={unfinished > 0
    ? `${unfinished} host${unfinished === 1 ? " has" : "s have"} not finished removing ${ENGINE_META[engine].label}. Forcing the purge deletes the stored credentials and accounts on the server anyway. This cannot be undone.`
    : `Deletes the stored ${ENGINE_META[engine].label} credentials and accounts on the server. This cannot be undone.`}
  confirmLabel={unfinished > 0 ? "Force purge" : "Purge"}
  destructive
  busy={$mutation.isPending}
  onConfirm={async () => { await $mutation.mutateAsync({ engine, action: "purge", force: unfinished > 0 }).catch(() => {}); purgeOpen = false; }}
/>
