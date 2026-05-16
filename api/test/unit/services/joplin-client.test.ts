import { describe, it, expect, vi } from 'vitest';
import { JoplinClient, parseSerializedItem } from '../../../src/services/joplin-client.js';

function makeFetcher(routes: Record<string, () => { status: number; body: string }>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    for (const [pattern, handler] of Object.entries(routes)) {
      if (path.startsWith(pattern)) {
        const { status, body } = handler();
        return new Response(body, { status });
      }
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

describe('parseSerializedItem', () => {
  it('parses a note with title, body, and property block', () => {
    const content = ['Hello title', '', 'first line', 'second line', '', 'id: abc', 'type_: 1', 'parent_id: folder1'].join('\n');
    const parsed = parseSerializedItem(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('abc');
    expect(parsed?.type_).toBe(1);
    expect(parsed?.title).toBe('Hello title');
    expect(parsed?.body).toBe('first line\nsecond line');
    expect(parsed?.parent_id).toBe('folder1');
  });

  it('returns null when the property block is malformed', () => {
    expect(parseSerializedItem('garbage with no colon')).toBeNull();
  });

  it('returns null when no type_ key is present', () => {
    expect(parseSerializedItem('Title\n\nbody\n\nid: x')).toBeNull();
  });
});

describe('JoplinClient.ping', () => {
  it('returns reachable=true on a 200 from the items endpoint', async () => {
    const fetcher = makeFetcher({
      '/api/sessions': () => ({ status: 200, body: JSON.stringify({ id: 'sess1' }) }),
      '/api/items/root/children': () => ({ status: 200, body: JSON.stringify({ items: [] }) }),
    });
    const client = new JoplinClient({
      url: 'https://joplin.example',
      email: 'a@b',
      password: 'pw',
      fetch: fetcher,
    });
    const r = await client.ping();
    expect(r.reachable).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('returns reachable=false and a reason when session creation fails', async () => {
    const fetcher = makeFetcher({
      '/api/sessions': () => ({ status: 401, body: 'invalid' }),
    });
    const client = new JoplinClient({
      url: 'https://joplin.example',
      email: 'a@b',
      password: 'pw',
      fetch: fetcher,
    });
    const r = await client.ping();
    expect(r.reachable).toBe(false);
    expect(r.reason).toContain('Could not create Joplin session');
  });

  it('refuses to ping without credentials', async () => {
    const client = new JoplinClient({ url: 'https://joplin.example', email: '', password: '' });
    const r = await client.ping();
    expect(r.reachable).toBe(false);
    expect(r.reason).toMatch(/email and password|required/i);
  });
});

describe('JoplinClient.listNotes', () => {
  it('paginates and returns parsed notes', async () => {
    const note1 = ['Note one', '', 'body one', '', 'id: a', 'type_: 1', 'parent_id: f1'].join('\n');
    const note2 = ['Note two', '', 'body two', '', 'id: b', 'type_: 1', 'parent_id: f1'].join('\n');
    const folder = ['Folder', '', '', 'id: f1', 'type_: 2', 'parent_id: '].join('\n');
    let listingCall = 0;
    const fetcher = vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/api/sessions')) {
        return new Response(JSON.stringify({ id: 'sess' }), { status: 200 });
      }
      if (url.includes('/api/items/root/children')) {
        listingCall += 1;
        if (listingCall === 1) {
          return new Response(
            JSON.stringify({
              items: [{ name: 'a.md' }, { name: 'b.md' }, { name: 'f1.md' }],
              has_more: false,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('/api/items/root:/a.md:/content')) {
        return new Response(note1, { status: 200 });
      }
      if (url.includes('/api/items/root:/b.md:/content')) {
        return new Response(note2, { status: 200 });
      }
      if (url.includes('/api/items/root:/f1.md:/content')) {
        return new Response(folder, { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    const client = new JoplinClient({
      url: 'https://joplin.example',
      email: 'a@b',
      password: 'pw',
      fetch: fetcher as unknown as typeof fetch,
    });
    const notes = await client.listNotes();
    expect(notes.length).toBe(2);
    expect(notes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(notes[0]?.body).toBeTruthy();
    const notebooks = await client.listNotebooks();
    expect(notebooks).toHaveLength(1);
    expect(notebooks[0]?.id).toBe('f1');
  });
});
