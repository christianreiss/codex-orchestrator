/**
 * Minimal HTTP client for a Joplin Server.
 *
 * The upstream protocol used by self-hosted Joplin Server requires obtaining a
 * session id via POST /api/sessions (email + password), then sending that id
 * back in the `X-API-AUTH` header on every subsequent request. Items are
 * serialised as filesystem-style markdown with a trailing property block; we
 * only need to parse them, not write.
 *
 * This is a substantially trimmed port of src/Services/JoplinService.php — it
 * exposes only the calls the new backend uses: ping(), listNotes(),
 * getNote(id), listNotebooks().
 */

export interface JoplinNoteSummary {
  id: string;
  title: string;
  body: string;
  parent_id: string;
  tags: string[];
  updated_time?: string;
}

export interface JoplinNotebookSummary {
  id: string;
  title: string;
  parent_id: string;
}

export interface JoplinPingResult {
  reachable: boolean;
  reason: string | null;
  version: string | null;
}

const TYPE_NOTE = 1;
const TYPE_FOLDER = 2;
const TYPE_TAG = 5;
const TYPE_NOTE_TAG = 6;

type Fetcher = typeof fetch;

interface ClientOptions {
  url: string;
  email: string;
  password: string;
  timeoutMs?: number;
  fetch?: Fetcher;
}

export class JoplinClient {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly fetcher: Fetcher;
  private sessionId: string | null = null;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.url.replace(/\/+$/, '');
    this.email = opts.email.trim();
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetcher = opts.fetch ?? ((...a) => fetch(...a));
  }

  async ping(): Promise<JoplinPingResult> {
    try {
      await this.ensureSession();
      const r = await this.request('GET', '/api/items/root/children?limit=1');
      if (r.status === 200) return { reachable: true, reason: null, version: null };
      return {
        reachable: false,
        reason: `Joplin returned HTTP ${r.status}`,
        version: null,
      };
    } catch (err) {
      return { reachable: false, reason: errMessage(err), version: null };
    }
  }

  async listNotes(limit = 1000): Promise<JoplinNoteSummary[]> {
    const snapshot = await this.snapshot();
    return limit > 0 && snapshot.notes.length > limit
      ? snapshot.notes.slice(0, limit)
      : snapshot.notes;
  }

  async getNote(noteId: string): Promise<JoplinNoteSummary | null> {
    const id = noteId.trim();
    if (!id) return null;
    const snapshot = await this.snapshot();
    return snapshot.notes.find((n) => n.id === id) ?? null;
  }

  async listNotebooks(): Promise<JoplinNotebookSummary[]> {
    const snapshot = await this.snapshot();
    return snapshot.notebooks;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    if (!this.baseUrl) throw new Error('Joplin URL is not configured');
    if (!this.email || !this.password) {
      throw new Error('Joplin email and password are required');
    }
    const body = new URLSearchParams({
      email: this.email,
      password: this.password,
      platform: 'linux',
      type: 'codex-orchestrator',
      version: '2026-04-03',
    }).toString();
    const r = await this.rawRequest('POST', '/api/sessions', body, {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    });
    if (r.status !== 200 && r.status !== 201) {
      throw new Error(`Could not create Joplin session: HTTP ${r.status}`);
    }
    const decoded = safeJson(r.text) as { id?: string } | null;
    const id = decoded?.id?.toString().trim();
    if (!id) throw new Error('Joplin Server did not return a session id');
    this.sessionId = id;
    return id;
  }

  private async request(method: string, path: string, body?: string): Promise<HttpRes> {
    await this.ensureSession();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-API-MIN-VERSION': '2.6.0',
      'X-API-AUTH': this.sessionId!,
    };
    let r = await this.rawRequest(method, path, body, headers);
    if (r.status === 401) {
      // Session may have expired — clear and retry once
      this.sessionId = null;
      await this.ensureSession();
      headers['X-API-AUTH'] = this.sessionId!;
      r = await this.rawRequest(method, path, body, headers);
    }
    return r;
  }

  private async rawRequest(
    method: string,
    path: string,
    body: string | undefined,
    headers: Record<string, string>,
  ): Promise<HttpRes> {
    const url = this.baseUrl + (path.startsWith('/') ? path : '/' + path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers,
        body,
        signal: controller.signal,
      };
      const res = await this.fetcher(url, init);
      const text = await res.text();
      return { status: res.status, text };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new Error(`Joplin request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private cachedSnapshot:
    | {
        notes: JoplinNoteSummary[];
        notebooks: JoplinNotebookSummary[];
      }
    | null = null;

  private async snapshot(): Promise<{
    notes: JoplinNoteSummary[];
    notebooks: JoplinNotebookSummary[];
  }> {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    const entries = await this.listAllItemEntries();
    const notes: JoplinNoteSummary[] = [];
    const notebooks: JoplinNotebookSummary[] = [];
    const tagsById = new Map<string, string>();
    const noteTagLinks: Array<{ noteId: string; tagId: string }> = [];

    for (const entry of entries) {
      const name = String(entry.name ?? '');
      if (!name.endsWith('.md')) continue;
      let content: string;
      try {
        content = await this.fetchSerializedItem(name);
      } catch {
        continue;
      }
      const item = parseSerializedItem(content);
      if (!item || typeof item.type_ !== 'number') continue;
      switch (item.type_) {
        case TYPE_NOTE:
          notes.push({
            id: String(item.id ?? ''),
            title: String(item.title ?? ''),
            body: String(item.body ?? ''),
            parent_id: String(item.parent_id ?? ''),
            tags: [],
            updated_time: item.updated_time ? String(item.updated_time) : undefined,
          });
          break;
        case TYPE_FOLDER:
          notebooks.push({
            id: String(item.id ?? ''),
            title: String(item.title ?? ''),
            parent_id: String(item.parent_id ?? ''),
          });
          break;
        case TYPE_TAG: {
          const id = String(item.id ?? '');
          const title = String(item.title ?? '').trim();
          if (id && title) tagsById.set(id, title);
          break;
        }
        case TYPE_NOTE_TAG: {
          const noteId = String(item.note_id ?? '').trim();
          const tagId = String(item.tag_id ?? '').trim();
          if (noteId && tagId) noteTagLinks.push({ noteId, tagId });
          break;
        }
      }
    }

    for (const link of noteTagLinks) {
      const tag = tagsById.get(link.tagId);
      if (!tag) continue;
      const note = notes.find((n) => n.id === link.noteId);
      if (!note) continue;
      if (!note.tags.includes(tag)) note.tags.push(tag);
    }

    notes.sort((a, b) => (b.updated_time ?? '').localeCompare(a.updated_time ?? ''));
    notebooks.sort((a, b) => a.title.localeCompare(b.title));

    this.cachedSnapshot = { notes, notebooks };
    return this.cachedSnapshot;
  }

  private async listAllItemEntries(): Promise<Array<{ name?: unknown }>> {
    const out: Array<{ name?: unknown }> = [];
    let page = 1;
    while (true) {
      const r = await this.request('GET', `/api/items/root/children?limit=100&page=${page}`);
      if (r.status !== 200) {
        throw new Error(`Could not list Joplin items: HTTP ${r.status}`);
      }
      const decoded = safeJson(r.text) as { items?: unknown; has_more?: boolean } | null;
      const items = Array.isArray(decoded?.items) ? (decoded!.items as unknown[]) : [];
      if (items.length === 0) break;
      for (const it of items) {
        if (it && typeof it === 'object' && 'name' in it) {
          out.push(it as { name: unknown });
        }
      }
      if (decoded?.has_more !== true) break;
      page += 1;
    }
    return out;
  }

  private async fetchSerializedItem(pathName: string): Promise<string> {
    const r = await this.request('GET', `/api/items/root:/${pathName}:/content`);
    if (r.status !== 200) {
      throw new Error(`Could not fetch Joplin item: HTTP ${r.status}`);
    }
    return r.text;
  }
}

interface HttpRes {
  status: number;
  text: string;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface ParsedItem {
  type_?: number;
  id?: string;
  title?: string;
  body?: string;
  parent_id?: string;
  note_id?: string;
  tag_id?: string;
  updated_time?: string;
  [k: string]: unknown;
}

/**
 * Joplin's filesystem serialisation: title, blank line, body, blank line,
 * then key:value pairs. We walk backwards to find the property block then
 * pluck `title` + `body` from the prefix.
 */
export function parseSerializedItem(content: string): ParsedItem | null {
  const lines = content.split(/\r\n|\r|\n/);
  const props: Record<string, string> = {};
  let bodyEndIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (line === '') {
      bodyEndIdx = i;
      break;
    }
    const sep = line.indexOf(':');
    if (sep === -1) return null;
    props[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  if (!('type_' in props)) return null;
  const out: ParsedItem = { ...props };
  out.type_ = Number(props['type_']);
  if (bodyEndIdx >= 0) {
    const bodyLines = lines.slice(0, bodyEndIdx);
    if (bodyLines.length > 0) {
      out.title = bodyLines[0] ?? '';
      let rest = bodyLines.slice(1);
      if (rest.length && rest[0] === '') rest = rest.slice(1);
      if (out.type_ === TYPE_NOTE) out.body = rest.join('\n');
    }
  }
  return out;
}
