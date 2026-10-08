/** Read-only native-client catalogue probe, with disposable config and local fixtures.
 * Usage: npx tsx scripts/check-grok-mcp.ts /absolute/path/to/grok /tmp/agent-tools.json
 * Export the local catalogue via CXX_MCP_CATALOG_EXPORT and TestMCPCatalogCompatibility.
 * Handler success/error coverage lives in the API and wrapper catalogue tests.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { McpToolsRegistry, type ToolDeps } from '../src/services/mcp-tools.js';
import { McpServer } from '../src/services/mcp-server.js';

const binary = process.argv[2];
const localCatalogue = process.argv[3];
if (!binary || !isAbsolute(binary) || !localCatalogue) {
  throw new Error('Provide an absolute Grok binary path and exported local tool catalogue');
}
const deps = Object.fromEntries(['memories', 'sharedMemories', 'projects', 'skills', 'resources',
  'fs', 'secrets', 'gitDirector', 'transfers', 'board', 'schedules', 'taskMessaging'].map(k => [k, {}])) as unknown as ToolDeps;
const catalogues = {
  cgx: new McpToolsRegistry(deps).list('operator'),
  'cxx-agent': JSON.parse(await readFile(localCatalogue, 'utf8')) as unknown[],
};
const dispatcher = new McpServer(new McpToolsRegistry(deps), deps.resources!, { log: async () => {} } as never);
const seen = new Set<string>();
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const request = JSON.parse(raw);
  if (request.id === undefined) { res.writeHead(202).end(); return; }
  const name = req.url?.slice(1) as keyof typeof catalogues;
  if (request.method === 'tools/call') {
    res.writeHead(400).end('Catalogue probe must not invoke tools'); return;
  }
  if (request.method === 'tools/list') seen.add(name);
  if (name === 'cgx') {
    const response = await dispatcher.handlePayload(request, {
      host: { id: 7 } as never, engine: 'grok', capability: 'operator', clientIp: null, serverVersion: 'fixture',
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
    return;
  }
  let result: unknown = {};
  if (request.method === 'initialize') result = {
    protocolVersion: '2025-06-18', capabilities: { tools: {} },
    serverInfo: { name, version: 'compatibility-fixture' },
  };
  else if (request.method === 'tools/list') { result = { tools: catalogues[name] }; seen.add(name); }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
});
const directory = await mkdtemp(join(tmpdir(), 'grok-mcp-compat-'));
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture listener');
  const config = join(directory, 'config.toml');
  await writeFile(config, '[compat.claude]\nmcps = false\n[compat.cursor]\nmcps = false\n' + Object.keys(catalogues).map(name =>
    `[mcp_servers.${JSON.stringify(name)}]\nurl = "http://127.0.0.1:${address.port}/${name}"\n`).join('\n'));
  // No inherited auth, fleet endpoint, live session or receiver environment.
  // doctor in 1.0.46 still discovers vendor MCPs despite compat.*.mcps=false.
  // Select each fixture explicitly so it cannot probe inherited live servers.
  for (const name of Object.keys(catalogues)) {
    const { stdout } = await promisify(execFile)(binary, ['mcp', 'doctor', name, '--json'], {
      cwd: directory, timeout: 30_000,
      env: { PATH: process.env.PATH, GROK_HOME: directory, GROK_CONFIG: config, GROK_CONFIG_PATH: config },
    });
    const report = JSON.parse(stdout);
    process.stdout.write(JSON.stringify({ servers: report.servers, healthy_count: report.healthy_count, failing_count: report.failing_count }) + '\n');
    if (report.failing_count !== 0 || report.healthy_count !== 1) throw new Error('Native MCP doctor failed');
  }
  if (seen.size !== Object.keys(catalogues).length) throw new Error('Native client did not load both catalogues');
  process.stdout.write(JSON.stringify({ loaded: Object.fromEntries(Object.entries(catalogues).map(([k, v]) => [k, v.length])) }) + '\n');
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
