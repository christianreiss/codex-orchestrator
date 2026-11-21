import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uuid = randomUUID;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const scriptPath = fileURLToPath(import.meta.url);
const rows = [];

// Publish a receipt only after the tool's response and durable effect have passed their assertions.
function verified(name, identity, outcome, source) {
  const line = new Error().stack.split('\n')[2].match(/:(\d+):\d+\)?$/)[1];
  rows.push([name, identity, outcome, source ?? 'docs/reports/' + path.basename(scriptPath) + ':' + line]);
  console.log('Verified ' + name);
}

async function workflow(ctx) {
  // This existing suite builds its own Fastify listeners. Give it a second schema.
  const name = 'review_operator_workflow_' + uuid().replaceAll('-', '');
  const suite = 'test/integration/workflow-http-e2e.test.ts';
  const report = path.join(ctx.store, 'workflow.json');
  await ctx.db.query('CREATE DATABASE ??', [name]);
  try {
    const env = { ...ctx.env, DB_DATABASE: name, TEST_USE_DB: '1', NODE_ENV: 'test' };
    execFileSync(process.execPath, [...ctx.runtime, 'src/db/migrate-cli.ts', '--init-schema'], {
      cwd: ctx.api,
      env,
      stdio: 'pipe',
    });
    execFileSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--no-file-parallelism',
        '--reporter=json',
        '--outputFile',
        report,
        suite,
      ],
      { cwd: ctx.api, env, stdio: 'pipe' },
    );
    const run = JSON.parse(await fs.readFile(report, 'utf8'));
    assert(run.success && run.numPassedTests > 0 && run.numPendingTests === 0);
    const source = (await fs.readFile(path.join(ctx.api, suite), 'utf8')).split('\n');
    const cite = (tool) => {
      const line = source.findIndex((s) => s.includes("name: '" + tool + "'"));
      assert(line > 0);
      return 'api/' + suite + ':' + (line + 1);
    };
    verified(
      'workflow_get',
      'synthetic workflow bridges',
      'Pinned revision one matched the submitted workflow document across three engines',
      cite('workflow_get'),
    );
    verified(
      'workflow_run_get',
      'synthetic workflow bridge c',
      'After API restart the original run ID and report URL matched and both stored tasks succeeded',
      cite('workflow_run_get'),
    );
  } finally {
    await ctx.db.query('DROP DATABASE ??', [name]);
    const [remaining] = await ctx.db.execute(
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=?',
      [name],
    );
    assert.equal(remaining.length, 0);
  }
}

export async function verifyAdditionalTools(ctx) {
  const { root, store, lab, db, ok, call, admin, h, other, op, a, attach } = ctx;
  const tool = async (name, args = {}, headers = h) => {
    const r = await call(headers, 'tools/call', { name, arguments: args });
    const val = r.structuredContent ?? JSON.parse(r.content[0].text);
    if (r.isError) throw Error(name + ': ' + (val.code ?? val.error?.code ?? JSON.stringify(val).slice(0, 250)));
    return val;
  };
  const flag = (name) => ok('POST', '/admin/' + name + '/state', { enabled: true }, admin);
  const host = 'synthetic VIP host',
    operator = 'synthetic operator + enrolled host';
  const slug = 'mcp-completion';
  await tool('project_create', { slug });
  const uri = 'shared://mcp.completion';
  await tool('resource_create', { uri, text: 'temporary discovery fixture' });
  const catalog = await tool('resource_list');
  assert(catalog.resources.some((r) => r.uri === uri));
  verified('resource_list', host, 'Listed the newly created shared resource at its exact URI');
  await tool('resource_delete', { uri });
  await flag('project-board');
  const card = (await tool('project_card_create', { slug, title: 'Synthetic review step' })).card;
  const target = { slug, card: card.id };
  const claimArgs = { ...target, role: 'code', client_request_id: uuid(), username: 'fixture', worktree_path: a.cwd };
  const claimed = await tool('project_card_claim', claimArgs, a.headers);
  assert(claimed.claimed && claimed.card.id === card.id && claimed.card.claim.role === 'code');
  assert.equal((await tool('project_card_claim', claimArgs, a.headers)).card.id, card.id);
  verified(
    'project_card_claim',
    'synthetic native session a',
    'Acquired and replayed the same card claim under the attached native identity',
  );
  const released = await tool('project_card_release', { ...target, resolution: 'done' }, a.headers);
  assert.equal(released.card.id, card.id);
  assert.equal(released.card.claim.held, false);
  assert(released.card.claim.released_at);
  assert.notEqual(released.to_column.key, released.from_column.key);
  verified(
    'project_card_release',
    'synthetic native session a',
    'Released the recorded claim and advanced the card to a different column',
  );

  await flag('host-spawn');
  const spawnArgs = {
    fqdn: 'new-system.fixture.invalid',
    engines: ['codex'],
    client_message_id: uuid(),
    daemon: { mode: 'none' },
  };
  const prepared = await tool('host_spawn_prepare', spawnArgs);
  assert(prepared.installer.url && prepared.operation_id && prepared.host_id);
  const repeated = await tool('host_spawn_prepare', spawnArgs);
  assert.equal(repeated.operation_id, prepared.operation_id);
  assert.equal(repeated.host_id, prepared.host_id);
  verified(
    'host_spawn_prepare',
    host,
    'Same request returned the same operation and host with one-time installer material',
  );
  const status = await tool('host_spawn_status', { operation_id: prepared.operation_id });
  assert.equal(status.state, 'registered');
  assert.equal(status.installer_used, false);
  assert.equal(status.daemon_connected, false);
  const [[spawnRow]] = await db.execute('SELECT target_host_id,setup_completed_at FROM host_spawns WHERE id=?', [
    prepared.operation_id,
  ]);
  assert.equal(Number(spawnRow.target_host_id), prepared.host_id);
  assert.equal(spawnRow.setup_completed_at, null);
  verified(
    'host_spawn_status',
    host,
    'SQL confirmed the new target, registered status, unused installer and no daemon connection',
  );

  await flag('feedback');
  const record = (
    await tool('feedback_submit', {
      type: 'feedback',
      title: 'Synthetic local review',
      description: 'Local-only recheck scenario',
      client_request_id: uuid(),
    })
  ).feedback;
  const config = await ok('GET', '/admin/feedback/configuration', undefined, admin);
  await ok(
    'POST',
    '/admin/feedback/configuration',
    {
      expected_revision: config.revision,
      config: { mode: 'user', runner_enabled: false, auto_publish: false, engine: null, model: null },
    },
    admin,
  );
  const read = (await tool('feedback_get', { id: record.id })).feedback;
  const queued = await tool('feedback_recheck', { id: record.id, expected_version: read.version });
  assert.equal(queued.id, record.id);
  assert.equal(queued.queued, true);
  const [[pipeline]] = await db.execute(
    'SELECT delivery_state,review_state,next_attempt_at FROM feedback_pipeline WHERE feedback_id=?',
    [record.id],
  );
  assert.equal(pipeline.delivery_state, 'local');
  assert.equal(pipeline.review_state, 'pending');
  assert(pipeline.next_attempt_at);
  verified(
    'feedback_recheck',
    host,
    'Queued this report for a local recheck with a durable deadline and pending review; external runner and publishing disabled',
  );

  await freshStart({ tool, call, ok, h, other, op, a, attach, db, operator, store });
  await slop({ tool, ok, flag, root, store, slug, host, db });
  await tool('project_archive', { slug });
  await workflow(ctx);
  assert.equal(new Set(rows.map((r) => r[0])).size, 19);
  await fs.writeFile(
    path.join(lab, 'additional-tools.tsv'),
    [['Tool', 'Identity', 'Verified scenario outcome', 'Source'], ...rows].map((r) => r.join('\t')).join('\n') + '\n',
    { flag: 'wx' },
  );
}

async function freshStart({ tool, call, ok, h, other, op, a, attach, db, operator, store }) {
  // The fixture reports its own missing transcript. No real agent process is replaced.
  const recipient = { session_id: uuid(), bridge_token: randomBytes(32).toString('base64url'), native: uuid() };
  const registered = await ok(
    'POST',
    '/host/agent-sessions',
    {
      engine: 'codex',
      username: 'fixture',
      cwd: path.join(store, 'missing-transcript'),
      invocation_kind: 'interactive',
      session_id: recipient.session_id,
      bridge_token: recipient.bridge_token,
      upstream_session_id: uuid(),
      adapter_capabilities: { execution_contract_version: 2, native_control_version: 1 },
    },
    h,
  );
  const ws = await attach(recipient, h);
  try {
    const sender = '/host/agent-sessions/' + a.session_id + '/agent-messaging';
    const receiver = '/host/agent-sessions/' + recipient.session_id + '/agent-messaging';
    const auth = { 'x-agent-bridge-token': recipient.bridge_token };
    const sent = await ok(
      'POST',
      sender + '/send',
      {
        to: registered.agent_address.address,
        content: 'Synthetic transcript fixture',
        kind: 'request',
        client_message_id: uuid(),
      },
      a.headers,
    );
    const messageId = sent.message.id,
      claim = uuid();
    const delivery = await ok('POST', receiver + '/deliveries/claim', { claim_id: claim, wait_seconds: 0 }, auth);
    assert.equal(delivery.delivery.message_id, messageId);
    await ok(
      'POST',
      receiver + '/deliveries/' + messageId + '/ack',
      { claim_id: claim, outcome: 'dead', error_code: 'native_transcript_missing' },
      auth,
    );
    const [[message]] = await db.execute(
      'SELECT status,execution_version,last_error_code,target_address_id FROM agent_bus_messages WHERE id=?',
      [messageId],
    );
    assert.equal(message.last_error_code, 'native_transcript_missing');
    const args = {
      message_id: messageId,
      version: message.execution_version,
      reason: 'Operator authorizes this synthetic missing-transcript fixture once',
    };
    const name = 'agent_fresh_start_approve';
    assert(!(await call(other, 'tools/list')).tools.some((t) => t.name === name));
    assert((await call(op, 'tools/list')).tools.some((t) => t.name === name));
    await assert.rejects(tool(name, args, other), /-32601/);
    const [[afterDenial]] = await db.execute(
      'SELECT status,execution_version,last_error_code,target_address_id FROM agent_bus_messages WHERE id=?',
      [messageId],
    );
    assert.deepEqual(afterDenial, message);
    const [noGrants] = await db.execute('SELECT message_id FROM agent_fresh_start_grants WHERE message_id=?', [
      messageId,
    ]);
    assert.equal(noGrants.length, 0);
    const granted = await tool('agent_fresh_start_approve', args, op);
    const repeat = await tool('agent_fresh_start_approve', args, op);
    assert.deepEqual(repeat.grant, granted.grant);
    const [grants] = await db.execute(
      'SELECT target_address_id,execution_version,approved_by,reason,consumed_claim_id FROM agent_fresh_start_grants WHERE message_id=?',
      [messageId],
    );
    assert.equal(grants.length, 1);
    assert.equal('agent:' + grants[0].target_address_id, registered.agent_address.address);
    assert.equal(grants[0].execution_version, Number(args.version) + 1);
    const [[enrolled]] = await db.execute('SELECT id FROM hosts WHERE fqdn=?', ['alpha.fixture.invalid']);
    assert.equal(grants[0].approved_by, 'operator:host:' + enrolled.id);
    assert.equal(grants[0].reason, args.reason);
    assert.equal(grants[0].consumed_claim_id, null);
    verified(
      'agent_fresh_start_approve',
      operator,
      'Host denial left message and grants unchanged; replayed operator approval persisted one grant, its operator audit actor, target and next execution version',
    );
  } finally {
    ws.close();
    await ok(
      'POST',
      '/host/agent-sessions/' + recipient.session_id + '/finish',
      { status: 'completed' },
      { ...h, 'x-agent-bridge-token': recipient.bridge_token },
    );
  }
}

async function slop({ tool, flag, root, store, slug, host, db }) {
  const source = path.join(root, 'slop-worker/vendor/slop-detector');
  const home = path.join(store, 'scanner');
  await fs.mkdir(home);
  await fs.symlink(path.join(source, 'node_modules'), path.join(home, 'node_modules'), 'dir');
  for (const f of await fs.readdir(source))
    if (f === 'package.json' || /^0\d-.*\.md$/.test(f)) await fs.symlink(path.join(source, f), path.join(home, f));
  execFileSync(
    process.execPath,
    [path.join(source, 'node_modules/typescript/bin/tsc'), '-p', source, '--outDir', path.join(home, 'dist')],
    { cwd: home, stdio: 'pipe' },
  );
  const worker = spawn(process.execPath, [path.join(root, 'slop-worker/worker.mjs')], {
    env: { PATH: process.env.PATH, DATA_ROOT: store, SLOP_HOME: home },
    stdio: 'ignore',
  });
  const stopped = new Promise((resolve) => worker.once('exit', resolve));
  try {
    await flag('transfers');
    await flag('slop-jobs');
    const job = (await tool('slop_job_create', { project: slug, title: 'Synthetic form contrast review' })).job;
    assert(
      job.job_id && job.project === slug && job.status === 'open' && job.title === 'Synthetic form contrast review',
    );
    verified('slop_job_create', host, 'Created an open review job with the requested project and title');
    const id = { job_id: job.job_id };
    assert((await tool('slop_job_list', { project: slug })).jobs.some((j) => j.job_id === job.job_id));
    verified('slop_job_list', host, 'Project listing returned the new open job ID');
    const description = 'Review the synthetic Save label and stylesheet.';
    const described = await tool('slop_job_describe', { ...id, description });
    assert(described.changed && described.job.has_description);
    verified('slop_job_describe', host, 'A new description revision was recorded and read back verbatim');
    const first = '<button>Save</button>\n',
      second = '<button>Save changes</button>\n',
      file = 'form.html';
    assert.equal(
      (await tool('slop_job_put', { ...id, path: file, kind: 'source', content: first })).sha256,
      sha(first),
    );
    const update = await tool('slop_job_put', { ...id, path: file, kind: 'source', content: second });
    assert.equal(update.rev, 2);
    assert.equal(update.sha256, sha(second));
    verified(
      'slop_job_put',
      host,
      'Two source revisions retained their expected bytes and independent SHA-256 digests',
    );
    const css = 'button { color: #142030; }\n';
    const bundle = JSON.stringify({ version: 1, files: [{ path: 'styles.css', content: css, sha256: sha(css) }] });
    const transfer = await tool('transfer_put', {
      name: 'sources.json',
      mime_type: 'application/json',
      ttl_seconds: 300,
      content_b64: Buffer.from(bundle).toString('base64'),
    });
    const transferId = transfer.id ?? transfer.transfer?.id ?? transfer.transfer_id;
    const batch = await tool('slop_job_import', { ...id, transfer_id: transferId });
    assert.equal(batch.imported, 1);
    assert.equal(batch.files[0].sha256, sha(css));
    verified('slop_job_import', host, 'Imported the transferred source bundle with the expected CSS SHA-256');
    const details = await tool('slop_job_get', id);
    assert.equal(details.job.description, description);
    assert.equal(details.files.find((f) => f.path === file)?.rev, 2);
    assert.equal(details.files.length, 2);
    verified(
      'slop_job_get',
      host,
      'The job contained the exact description and both current source paths including revision two',
    );
    const diff = await tool('slop_job_diff', { ...id, path: file, from_rev: 1, to_rev: 2 });
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    assert(diff.diff.includes('-' + first.trim()) && diff.diff.includes('+' + second.trim()));
    verified('slop_job_diff', host, 'The unified revision diff showed the expected removed and added Save labels');
    const req = { ...id, mode: 'quick', client_message_id: uuid(), wait_seconds: 0 };
    const one = await tool('slop_job_run', req);
    assert.equal(one.run.mode, 'quick');
    assert.equal((await tool('slop_job_run', req)).run.run_id, one.run.run_id);
    verified('slop_job_run', host, 'Replaying the same quick scan returned its original run ID');
    let result;
    for (let i = 0; i < 20; i++) {
      result = await tool('slop_job_result', { ...id, run: one.run.run_id, wait_seconds: 3 });
      if (!['scanning', 'pending', 'validating', 'reviewing'].includes(result.run.status)) break;
    }
    assert.equal(result.run.status, 'completed', result.run.error);
    assert(result.report && Array.isArray(result.report.findings));
    assert.equal(result.run.scanned_source_files, 2);
    verified(
      'slop_job_result',
      host,
      'The shipped scanner completed locally and returned a structured report covering two source files',
    );
    const closed = await tool('slop_job_close', id);
    assert.equal(closed.closed, true);
    assert(!(await tool('slop_job_list', { project: slug })).jobs.some((j) => j.job_id === job.job_id));
    const [[count]] = await db.execute('SELECT COUNT(*) AS n FROM slop_jobs WHERE id=?', [job.job_id]);
    assert.equal(Number(count.n), 0);
    verified(
      'slop_job_close',
      host,
      'The closed job disappeared from the project listing and its MySQL row was removed',
    );
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
    await stopped;
  }
}

export async function writeLiveCatalog({ lab, ok, call, admin, h, op }) {
  await ok('POST', '/admin/roles/state', { enabled: true }, admin);
  const ordinary = (await call(h, 'tools/list')).tools;
  const privileged = (await call(op, 'tools/list')).tools;
  const hostNames = new Set(ordinary.map((tool) => tool.name));
  const names = new Set(privileged.map((tool) => tool.name));
  assert.equal(hostNames.size, ordinary.length);
  assert.equal(names.size, privileged.length);
  for (const name of hostNames) assert(names.has(name));
  assert.equal(names.size, 107);
  const catalog = privileged
    .map(({ name, description }) => {
      assert.equal(typeof description, 'string');
      assert(description.length);
      return { name, capability: hostNames.has(name) ? 'host' : 'operator', description };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  assert.deepEqual(
    catalog
      .filter((tool) => tool.capability === 'operator')
      .map((tool) => tool.name)
      .sort(),
    [
      'agent_fresh_start_approve',
      'fs_file_exists',
      'fs_list_dir',
      'fs_read_file',
      'fs_search_in_files',
      'fs_stat',
      'fs_write_file',
    ],
  );
  await fs.writeFile(path.join(lab, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
}
