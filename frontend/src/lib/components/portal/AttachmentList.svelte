<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api/client';
  import { attachmentBase, attachmentUrl, type ChatFile } from '$lib/portal/chat-files';
  let { session, ids }: { session: string; ids: string[] } = $props();
  let files = $state<ChatFile[]>([]);
  let error = $state('');
  let expanded = $state<string | null>(null);
  onMount(() => {
    let stopped = false;
    async function refresh() {
      try { const rows = await Promise.all(ids.map(id => api.get<ChatFile>(`${attachmentBase(session)}/${id}`))); if (!stopped) { files = rows; error = ''; } }
      catch(e) { if (!stopped) error = e instanceof Error ? e.message : 'Attachment unavailable'; }
    }
    void refresh(); const timer = setInterval(() => { if (!files.length || files.some(f => f.processing && ['queued','processing'].includes(f.processing.state))) void refresh(); }, 5000);
    return () => { stopped = true; clearInterval(timer); };
  });
</script>
<div class="mt-2 grid gap-2">
  {#if error}<p class="text-caption text-destructive">{error}</p>{/if}
  {#each files as file (file.id)}
    <div class="rounded-md border border-current/20 p-2">
      {#if /^image\/(png|jpeg|gif|webp)$/.test(file.mime_type)}
        <button type="button" onclick={() => expanded = file.id} aria-label={`Open ${file.name}`}><img src={attachmentUrl(session, file.id, undefined, true)} alt={file.name} loading="lazy" class="max-h-56 max-w-full rounded-md" /></button>
      {:else if file.mime_type.startsWith('audio/')}<audio controls preload="none" src={attachmentUrl(session, file.id, undefined, true)} class="max-w-full"></audio>
      {:else if file.mime_type.startsWith('video/')}<video controls preload="metadata" src={attachmentUrl(session, file.id, undefined, true)} class="max-h-64 max-w-full rounded-md"><track kind="captions" /></video>{/if}
      <a class="block break-all text-caption underline" href={attachmentUrl(session, file.id)}>{file.name} · {(file.size_bytes / 1024 / 1024).toFixed(1)} MiB</a>
      {#if file.processing}
        <p class="text-caption">{file.processing.state === 'ready' ? 'Prepared for agent' : file.processing.error || `Media preparation: ${file.processing.state}`}</p>
        {#if file.processing.state === 'ready' && file.processing.transcript}<a href={attachmentUrl(session, file.id, 'transcript.json')} class="text-caption underline">Download transcript</a>{/if}
        {#if file.processing.state === 'ready' && file.processing.frames?.length}<details class="text-caption"><summary>Video frames</summary><div class="grid grid-cols-2 gap-1">{#each file.processing.frames as frame}<a href={attachmentUrl(session,file.id,frame.variant)}><img src={attachmentUrl(session,file.id,frame.variant,true)} alt={`Frame at ${frame.timestamp.toFixed(1)}s`} loading="lazy" /></a>{/each}</div></details>{/if}
      {/if}
    </div>
  {/each}
</div>
{#if expanded}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/90 p-6" role="presentation" onclick={() => expanded = null}>
    <button class="absolute right-4 top-4 rounded-md bg-white px-3 py-2 text-black" type="button" onclick={() => expanded = null}>Close image</button>
    <img src={attachmentUrl(session, expanded, undefined, true)} alt="Full attachment" class="max-h-full max-w-full" />
  </div>
{/if}
