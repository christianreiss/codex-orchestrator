import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.env.REVIEW_TEST_URL);
const password = process.env.REVIEW_TEST_PASSWORD;
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || !password) {
  throw new Error('Supply an explicitly disposable loopback owner URL and synthetic password.');
}
const slug = 'review-' + randomUUID().slice(0, 12);
let cookie, key, hostId, projectCreated = false;
const restore = [];
const succeeded = new Set();
const marker = 'Disposable note ' + slug;
const has = (value, target) => assert(JSON.stringify(value).includes(target), 'Round-trip value missing');
async function http(method, path, data, auth) {
  const response = await fetch(new URL(path, base), {
    method, headers: { accept: 'application/json', ...auth,
      ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (path === '/admin/auth/login') cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  const body = await response.json();
  assert(response.ok, method + ' ' + path + ' returned ' + response.status + ' ' + (body.code ?? ''));
  return body.data ?? body;
}
async function admin(method, path, args) {
  return http(method, path, args, { origin: base.origin, ...(cookie ? { cookie } : {}) });
}
async function setFeature(feature, enabled) {
  const request = { enabled };
  if (feature === '/admin/workflow-definitions/state') request.client_request_id = randomUUID();
  return admin('POST', feature, request);
}
async function rpc(method, params) {
  return http('POST', '/mcp', { jsonrpc: '2.0', id: randomUUID(), method, params },
    { 'x-api-key': key, 'x-engine': 'codex' });
}
async function tool(name, args = {}) {
  const reply = await rpc('tools/call', { name, arguments: args });
  assert(!reply.error && !reply.result?.isError, name + ' returned an MCP error');
  succeeded.add(name);
  const text = reply.result.content.map(c => c.text).join('\n');
  try { return JSON.parse(text); } catch { return text; }
}
const project = (name, args) => tool('project_' + name, { slug, ...args });
try {
  await admin('POST', '/admin/auth/login', { username: process.env.REVIEW_TEST_USER, password });
  assert(cookie, 'Test owner did not receive a session');
  for (const feature of ['/admin/projects/state', '/admin/project-board/state', '/admin/transfers/state', '/admin/secrets/state', '/admin/feedback/state', '/admin/workflow-definitions/state', '/admin/git-director/state', '/admin/roles/state']) {
    const initial = await admin('GET', feature);
    assert.equal(typeof initial.enabled, 'boolean');
    if (!initial.enabled) {
      await setFeature(feature, true);
      restore.push(feature);
    }
  }
  const registered = await admin('POST', '/admin/hosts/register', {
    fqdn: slug + '.fixture.invalid', engines: ['codex'], secure: true, reverse_dns_mode: 'disabled',
  });
  hostId = registered.host.id;
  key = registered.host.api_key;
  assert(key && hostId);
  assert((await rpc('tools/list', {})).result.tools.some(t => t.name === 'project_create'));
  await project('create', { about: { purpose: marker } }); projectCreated = true;
  has(await tool('project_list'), slug);
  await project('update', { about: { purpose: marker + ' updated' } });
  for (const action of ['detail', 'summary', 'bootstrap']) has(await project(action), marker + ' updated');
  const note = (await project('note_upsert', { header: 'Inspection', body: marker })).note;
  assert(note.id);
  await project('note_upsert', { id: note.id, header: 'Inspection', body: marker + ' revised' });
  has(await project('notes'), marker + ' revised');
  await project('note_delete', { id: note.id });
  assert(!JSON.stringify(await project('notes')).includes(marker));
  const file = (await project('file_upsert', { stored_name: 'note.txt', content: marker })).file;
  assert(file.id);
  has(await project('files'), 'note.txt');
  has(await project('file_read', { id: file.id }), marker);
  await project('file_delete', { id: file.id });
  assert(!JSON.stringify(await project('files')).includes('note.txt'));
  await project('memory_upsert', { key: 'fixture', content: marker });
  has(await project('memory_get', { key: 'fixture' }), marker);
  has(await project('memory_list'), 'fixture');
  has(await project('memory_search', { query: 'Disposable' }), 'fixture');
  await project('memory_delete', { key: 'fixture' });
  assert(!JSON.stringify(await project('memory_list')).includes('"fixture"'));
  const feedback = (await project('feedback_create', { type: 'test', title: 'Review', body: marker })).feedback;
  await project('feedback_update', { id: feedback.id, status: 'acknowledged' });
  has(await project('feedback_list'), 'acknowledged');
  const todoResult = await project('todo_create', { title: 'Verify review output', detail: marker });
  const todo = todoResult.todo?.id ?? todoResult.card?.number;
  assert(todo, 'Todo ID missing');
  await project('todo_update', { id: todo, title: 'Verify final output', detail: marker });
  await project('todo_done', { id: todo });
  await project('todo_undone', { id: todo });
  has(await project('board_list'), 'Verify final output');
  has(await project('changes', { since: 0 }), slug);
  await project('archive');
  await project('unarchive');
  has(await admin('GET', '/admin/projects/' + slug), marker + ' updated');
  const memory = await tool('memory_store', { content: marker });
  has(await tool('memory_retrieve', { id: memory.id }), marker);
  has(await tool('memory_search', { query: marker }), memory.id);
  await tool('memory_delete', { id: memory.id });
  assert.equal((await tool('memory_retrieve', { id: memory.id })).status, 'missing');
  const sharedSlug = slug + '.notes';
  await tool('shared_memory_write', { slug: sharedSlug, content: marker });
  const first = await tool('shared_memory_read', { slug: sharedSlug });
  await tool('shared_memory_replace', {
    slug: sharedSlug, old_text: 'Disposable', new_text: 'Detailed', expected_sha256: first.memory.sha256,
  });
  await tool('shared_memory_append', { slug: sharedSlug, content: 'Second observation' });
  const updated = await tool('shared_memory_read', { slug: sharedSlug });
  has(updated.content, 'Second observation');
  has(updated.content, 'Detailed');
  has(await tool('shared_memory_search', { query: slug }), sharedSlug);
  has(await tool('shared_memory_list'), sharedSlug);
  await tool('shared_memory_delete', { slug: sharedSlug });
  assert.equal((await tool('shared_memory_read', { slug: sharedSlug })).status, 'missing');
  const token = randomUUID();
  await tool('secret_store', { slug, value: token, name: slug });
  has(await tool('secret_search', { query: slug }), slug);
  const listed = await tool('secret_list');
  has(listed, slug);
  assert(!JSON.stringify(listed).includes(token));
  assert.equal((await tool('secret_get', { slug })).value, token);
  await tool('secret_delete', { slug });
  const manifest = '---\nname: ' + slug + '\ndescription: Temporary review fixture\n---\n\n' + marker;
  await tool('skill_store', { slug, manifest });
  has(await tool('skill_list'), slug);
  has((await tool('skill_retrieve', { slug })).manifest, marker);
  await tool('skill_delete', { slug });
  assert.equal((await tool('skill_retrieve', { slug })).status, 'deleted');
  const bytes = Buffer.from([0, 7, 128, 255]);
  const transfer = (await tool('transfer_put', { name: 'fixture.bin', content_b64: bytes.toString('base64'), ttl_seconds: 300 })).transfer;
  has(await tool('transfer_list'), transfer.id);
  has(await tool('transfer_info', { id: transfer.id }), transfer.id);
  assert.deepEqual(Buffer.from((await tool('transfer_get', { id: transfer.id })).content_b64, 'base64'), bytes);
  await tool('transfer_delete', { id: transfer.id });
  const cardResult = await project('card_create', { title: marker, role: 'plan' });
  const card = cardResult.card.number;
  has(await project('card_get', { card }), marker);
  has(await project('card_update', { card, title: marker + ' updated' }), marker + ' updated');
  const rejectedClaim = await rpc('tools/call', {
    name: 'project_card_claim', arguments: { slug, card, role: 'plan' },
  });
  assert(rejectedClaim.error || rejectedClaim.result?.isError);
  assert.match(JSON.stringify(rejectedClaim), /card_identity_required|authenticated native session required/i);
  await project('card_move', { card, column: 'planning', role: 'plan' });
  has(await project('card_get', { card }), 'planning');
  await tool('feedback_preflight', { title: marker });
  const submitted = { client_request_id: randomUUID(), type: 'feedback', title: marker, description: marker };
  const feedbackId = (await tool('feedback_submit', submitted)).feedback.id;
  assert.equal((await tool('feedback_submit', submitted)).feedback.id, feedbackId);
  has(await tool('feedback_get', { id: feedbackId }), marker);
  has(await tool('feedback_list', { query: marker }), feedbackId);
  const claim = await tool('feedback_claim', { id: feedbackId, action: 'acquire', client_request_id: randomUUID() });
  const closed = await tool('feedback_update', {
    id: feedbackId, claim_token: claim.claim_token, expected_version: claim.feedback.version,
    status: 'dismissed', reason: 'Disposable acceptance case complete',
  });
  assert.equal(closed.feedback.status, 'dismissed');
  await admin('DELETE', '/admin/feedback/' + feedbackId);
  for (const read of ['role_list', 'workflow_list', 'workflow_run_list', 'git_list']) {
    assert(await tool(read));
  }
  console.log('MCP tools returning success (' + succeeded.size + '): ' + [...succeeded].sort().join(', '));
} finally {
  if (projectCreated) await admin('DELETE', '/admin/projects/' + slug);
  if (hostId) await admin('DELETE', '/admin/hosts/' + hostId);
  for (const feature of restore.reverse()) await setFeature(feature, false);
}
