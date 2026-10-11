import { api } from '$lib/api/client';
export interface ChatFile { id: string; name: string; mime_type: string; size_bytes: number; status: string; uploaded_bytes: number; sha256?: string; processing?: {state: string; error?: string; frames?: Array<{variant: string; timestamp: number}>; transcript?: string} }
export interface UploadItem { id: string; file: File; progress: number; state: 'uploading' | 'ready' | 'failed'; error?: string }
export function attachmentUrl(session: string, id: string, variant?: string, inline = false) { return `/admin/agent-sessions/${encodeURIComponent(session)}/attachments/${encodeURIComponent(id)}/content?inline=${inline ? '1' : '0'}${variant ? `&variant=${encodeURIComponent(variant)}` : ''}`; }
export async function uploadChatFile(session: string, item: UploadItem, signal: AbortSignal, progress: (offset: number) => void): Promise<ChatFile> {
  const base = `/admin/agent-sessions/${session}/attachments`;
  const info = await api.post<ChatFile>(base, { id: item.id, name: item.file.name, mime_type: item.file.type || 'application/octet-stream', size_bytes: item.file.size }, { signal });
  let offset = info.uploaded_bytes;
  while (offset < item.file.size) {
    const buffer = new Uint8Array(await item.file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer());
    // Avoid spread argument limits for multi-MiB files.
    let binary = ''; for (let n = 0; n < buffer.length; n += 8192) binary += String.fromCharCode(...buffer.subarray(n, n + 8192));
    const next = await api.post<ChatFile>(`${base}/${item.id}/chunks`, { offset, content_b64: btoa(binary) }, { signal });
    offset = next.uploaded_bytes; progress(offset);
  }
  return api.post<ChatFile>(`${base}/${item.id}/seal`, {}, { signal });
}
