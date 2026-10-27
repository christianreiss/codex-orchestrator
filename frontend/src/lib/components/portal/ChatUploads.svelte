<script lang="ts">
  import { onDestroy } from 'svelte';
  import { api } from '$lib/api/client';
  import { buttonVariants } from '$lib/components/ui/button';
  import { attachmentBase, uploadChatFile, type UploadItem } from '$lib/portal/chat-files';
  let { session, items, onitems, disabled = false }: {session: string; items: UploadItem[]; onitems: (session: string, items: UploadItem[]) => void; disabled?: boolean} = $props();
  let error = $state('');
  let closed = false;
  let recording = $state<'audio' | 'video' | null>(null);
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  const previews = new Map<File,string>();
  function preview(file:File) { let url=previews.get(file); if(!url) { url=URL.createObjectURL(file); previews.set(file,url); } return url; }
  const requests = new Map<string, AbortController>();
  function change(id: string, update: Partial<UploadItem>) { if (!closed) onitems(session, items.map(i => i.id === id ? {...i, ...update} : i)); }
  async function upload(item: UploadItem) {
    const abort = new AbortController(); requests.set(item.id, abort); change(item.id, {state:'uploading',error:undefined});
    try { await uploadChatFile(session, item, abort.signal, bytes => change(item.id, {progress:bytes / item.file.size})); change(item.id, {state:'ready',progress:1}); }
    catch(e) { change(item.id, {state:'failed',error: e instanceof Error ? e.message : 'Upload failed'}); }
    finally { requests.delete(item.id); }
  }
  async function add(files: File[]) {
    const limits = await api.get<{max_file_bytes:number; max_total_bytes:number;max_attachments:number}>('/admin/agent-chat/limits').catch(() => ({max_file_bytes:100*1024*1024,max_total_bytes:250*1024*1024,max_attachments:10}));
    if (closed) return;
    if (items.length + files.length > limits.max_attachments || files.some(f => !f.size || f.size > limits.max_file_bytes) || [...items.map(i => i.file),...files].reduce((s,f) => s+f.size,0) > limits.max_total_bytes) { error = 'Attachment limit exceeded: ten files, 100 MiB per file, 250 MiB total by default.'; return; }
    const next = files.map(file => ({id:crypto.randomUUID(),file,progress:0,state:'uploading' as const})); onitems(session, [...items,...next]); error = '';
    // Serial uploads keep memory and base64 request size bounded.
    for (const item of next) { if (closed) break; await upload(item); }
  }
  async function remove(item: UploadItem) { requests.get(item.id)?.abort(); onitems(session, items.filter(i => i.id !== item.id)); await api.delete(`${attachmentBase(session)}/${item.id}`).catch(() => {}); }
  function stop() { if (recorder?.state === 'recording') recorder.stop(); stream?.getTracks().forEach(t => t.stop()); clearTimeout(captureTimer); recording = null; }
  async function record(kind:'audio'|'video') {
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio:true,video:kind === 'video'});
      if (closed) { stream.getTracks().forEach(t => t.stop()); return; }
      recorder = new MediaRecorder(stream); const chunks: Blob[] = []; const mime = recorder.mimeType || `${kind}/webm`;
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => { void add([new File(chunks, `${kind}-${Date.now()}.webm`, {type:mime.split(';')[0]})]); stream?.getTracks().forEach(t => t.stop()); recording = null; };
      recording = kind; recorder.start(1000); captureTimer = setTimeout(stop,900000);
    } catch(e) { error = e instanceof Error ? e.message : 'Recording unavailable'; stream?.getTracks().forEach(t => t.stop()); }
  }
  onDestroy(() => { closed = true; previews.forEach(url => URL.revokeObjectURL(url)); if(recorder) recorder.onstop = null; stop(); requests.forEach(r => r.abort()); onitems(session, items.map(i => i.state === 'uploading' ? {...i,state:'failed',error:'Upload paused; retry to resume.'} : i)); });
</script>
<div class="border-t px-4 py-2 text-caption">
  <div class="flex flex-wrap items-center gap-3">
    <label class={`${buttonVariants({variant:'outline'})} file-picker cursor-pointer focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2`}>Attach files<input type="file" multiple class="sr-only" disabled={disabled} onchange={e => { void add(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value=''; }} /></label>
    <label class={`${buttonVariants({variant:'outline'})} file-picker cursor-pointer focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2`}>Photo<input type="file" accept="image/*" capture="environment" class="sr-only" disabled={disabled} onchange={e => { void add(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value=''; }} /></label>
    {#if recording}<button type="button" class="text-destructive" onclick={stop}>Stop {recording} recording</button>
    {:else}<button type="button" disabled={disabled} onclick={() => record('audio')}>Record audio</button><button type="button" disabled={disabled} onclick={() => record('video')}>Record video</button>{/if}
  </div>
  {#if error}<p role="alert" class="mt-1 text-destructive">{error}</p>{/if}
  {#each items as item (item.id)}
    {#if item.file.type.startsWith("image/")}<img src={preview(item.file)} alt={item.file.name} class="mt-2 max-h-20 rounded-md" />{/if}
    <div class="mt-2 flex items-center gap-2"><span class="min-w-0 flex-1 truncate">{item.file.name} · {item.state === 'uploading' ? `${Math.round(item.progress*100)}%` : item.state}</span>
      {#if item.state === 'failed'}<button type="button" onclick={() => upload(item)}>Retry upload</button>{/if}
      <button type="button" disabled={disabled} onclick={() => remove(item)}>Remove</button>
    </div>
    {#if item.error}<p class="text-destructive">{item.error}</p>{/if}
  {/each}
</div>

<style>
  @media (any-pointer: coarse) {
    .file-picker { min-height: 44px; min-width: 44px; }
  }
</style>
