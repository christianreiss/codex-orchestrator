// Run from the repository root. See orchestrator-handler-evidence.md.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ts = createRequire(path.resolve('api/package.json'))('typescript');
const [coveragePath, coverageRevision, output = 'docs/reports/orchestrator-handler-evidence.tsv'] = process.argv.slice(2);
if (!coveragePath || !coverageRevision) throw Error('Expected LCOV path, tested Git revision and optional output TSV');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const sha256 = data => createHash('sha256').update(data).digest('hex');
const filename = 'docs/reports/orchestrator-entrypoints.tsv';
const inventory = fs.readFileSync(filename, 'utf8');
const [head, ...lines] = inventory.trimEnd().split('\n').map(l => l.split('\t'));
const positions = Object.fromEntries(head.map((v,i) => [v,i]));
const entries = lines.filter(row => row[positions['Entry kind']] === 'HTTP').map(row => ({
  family: row[positions.Family], operation: row[positions['Entry or action']], registration: row[positions['Registration / source']],
}));
if (!entries.length || new Set(entries.map(row => row.operation)).size !== entries.length) throw Error('Invalid HTTP inventory');

const configFile = ts.readConfigFile('api/tsconfig.json', ts.sys.readFile);
if (configFile.error) throw Error('Cannot read api/tsconfig.json');
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.resolve('api'));
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();
const bodyFunction = n => ts.isFunctionLike(n) && n.body;
const fileName = n => path.relative(process.cwd(), n.getSourceFile().fileName);
const startLine = n => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
const ast = new Map();
function indexFile(file) {
  if (ast.has(file)) return ast.get(file);
  const info = { registrations: new Map(), functions: new Map() };
  function put(map, line, obj) { if (!map.has(line)) map.set(line, []); map.get(line).push(obj); }
  function walk(n) {
    if (bodyFunction(n)) put(info.functions, startLine(n), n);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
      /^(app|fastify|server|scope|instance)$/.test(n.expression.expression.getText()) &&
      /^(get|post|put|patch|delete|head|options|all|route)$/.test(n.expression.name.text)) {
      put(info.registrations, startLine(n), n);
    }
    ts.forEachChild(n, walk);
  }
  const src = program.getSourceFile(path.resolve(file));
  if (src) walk(src);
  ast.set(file, info);
  return info;
}
function strip(n) {
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n))) n = n.expression;
  return n;
}
function property(obj, name) {
  return ts.isObjectLiteralExpression(obj) ? obj.properties.find(p => p.name?.getText().replace(/^['"]|['"]$/g, '') === name) : undefined;
}
function functionAt(node, seen = new Set()) {
  const n = strip(node);
  if (!n || seen.has(n)) return;
  seen.add(n);
  if (bodyFunction(n)) return n;
  if (ts.isIdentifier(n)) {
    let symbol = checker.getSymbolAtLocation(n);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.valueDeclaration;
    if (!decl || !fileName(decl).startsWith('api/src/')) return;
    if (bodyFunction(decl)) return decl;
    if (ts.isVariableDeclaration(decl) && (decl.parent.flags & ts.NodeFlags.Const)) return functionAt(decl.initializer, seen);
  }
  if (ts.isPropertyAccessExpression(n)) {
    const decl = checker.getSymbolAtLocation(n.name)?.valueDeclaration;
    // A concrete object-literal method has a body. Interface declarations and
    // overridable class methods do not identify the function value at runtime.
    if (decl && fileName(decl).startsWith('api/src/') && ts.isObjectLiteralExpression(decl.parent) &&
        ts.isMethodDeclaration(decl) && decl.body) return decl;
  }
  if (ts.isCallExpression(n)) {
    const factory = functionAt(n.expression, seen);
    if (!factory) return;
    if (!ts.isBlock(factory.body)) return functionAt(factory.body, seen);
    const returns = [];
    function collect(child) {
      if (ts.isFunctionLike(child)) return;
      if (ts.isReturnStatement(child)) returns.push(child.expression);
      else ts.forEachChild(child, collect);
    }
    collect(factory.body);
    if (returns.length === 1) return functionAt(returns[0], seen);
  }
}
// Our onRoute hook replaces Fastify's synthetic HEAD callback for WS-only
// registrations. Require its exact guard and assignment before attributing it.
function websocketHeadCallback() {
  const src = program.getSourceFile(path.resolve('api/src/ws/transport.ts'));
  const matches = [];
  function walk(n) {
    if (ts.isIfStatement(n) && ts.isBinaryExpression(n.expression) &&
        n.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        n.expression.left.getText().match(/^route\.method\s*===\s*['"]HEAD['"]$/) &&
        n.expression.right.getText() === 'route.websocket' && ts.isBlock(n.thenStatement)) {
      for (const s of n.thenStatement.statements) {
        if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) &&
            s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            s.expression.left.getText() === 'route.handler' && bodyFunction(s.expression.right)) matches.push(s.expression.right);
      }
    }
    ts.forEachChild(n, walk);
  }
  if (src) walk(src);
  return matches.length === 1 ? matches[0] : undefined;
}
const socketHead = websocketHeadCallback();
const groups = new Map();
for (const row of entries) {
  const m = row.registration.match(/^(api\/src\/.+\.ts):(\d+)$/);
  if (!m) { row.issue = 'plugin-no-registration-line'; continue; }
  const sites = indexFile(m[1]).registrations.get(Number(m[2])) ?? [];
  if (sites.length !== 1) { row.issue = 'registration-not-unique'; continue; }
  const site = sites[0], last = site.arguments.at(-1);
  const declared = site.expression.name.text;
  const spec = declared === 'route' ? property(site.arguments[0], 'method')?.initializer : undefined;
  const methods = declared !== 'route' ? [declared.toUpperCase()] : spec && ts.isStringLiteral(spec) ? [spec.text] :
    spec && ts.isArrayLiteralExpression(spec) && spec.elements.every(ts.isStringLiteral) ? spec.elements.map(x => x.text) : [];
  const method = row.operation.split(' ', 1)[0];
  if (methods.length && !methods.includes('ALL') && !methods.includes(method) && !(method === 'HEAD' && methods.includes('GET'))) {
    row.issue = 'registration-method-mismatch'; continue;
  }
  const prop = property(last, 'handler');
  const websocket = site.arguments.some(arg => property(arg, 'websocket')?.initializer?.kind === ts.SyntaxKind.TrueKeyword);
  const cb = strip(prop ? (ts.isPropertyAssignment(prop) ? prop.initializer : ts.isShorthandPropertyAssignment(prop) ? prop.name : prop) : last);
  row.shape = ts.isCallExpression(cb) ? 'factory-return' : (ts.isIdentifier(cb) || ts.isPropertyAccessExpression(cb)) ? 'reference' : bodyFunction(cb) ? 'inline' : 'dynamic';
  if (row.shape === 'reference' || row.shape === 'factory-return')
    row.binding = cb.getText().replace(/\s+/g, ' ');
  row.role = method === 'HEAD' && !methods.includes('HEAD') && methods.includes('GET') ? 'generated-HEAD' : '';
  if (websocket) row.role = row.role ? row.role + '+websocket' : 'websocket';
  if (row.role === 'generated-HEAD+websocket') {
    row.shape = 'transport-override';
    row.body = socketHead;
  } else row.body = functionAt(cb);
  if (!row.body) { row.issue = 'handler-not-resolved'; continue; }
  row.file = fileName(row.body);
  row.line = startLine(row.body);
  if (!groups.has(row.body)) groups.set(row.body, []);
  groups.get(row.body).push(row);
}

const raw = fs.readFileSync(coveragePath, 'utf8');
const records = new Map();
for (const part of raw.split(/^end_of_record\s*$/m)) {
  if (!part.trim()) continue;
  const file = part.match(/^SF:(.+)$/m)?.[1];
  if (!file) throw Error('Incomplete LCOV record');
  const normalized = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file.startsWith('src/') ? 'api/' + file : file;
  const defs = [...part.matchAll(/^FN:(\d+),(.+)$/gm)];
  const counts = [...part.matchAll(/^FNDA:(\d+),(.+)$/gm)];
  // The pinned Istanbul reporter emits both arrays in functionMap order.
  if (defs.length !== counts.length || defs.some((m,i) => m[2] !== counts[i][2]) || records.has(normalized))
    throw Error('Unexpected LCOV function format or duplicate source: ' + normalized);
  const byLine = new Map();
  defs.forEach(([_, line, name], i) => {
    const n = Number(line);
    if (!byLine.has(n)) byLine.set(n, []);
    byLine.get(n).push({ name, count: Number(counts[i][1]) });
  });
  const lineCounts = new Map([...part.matchAll(/^DA:(\d+),(\d+)(?:,.*)?$/gm)].map(m => [Number(m[1]), Number(m[2])]));
  records.set(normalized, { byLine, lineCounts });
}
if (!records.size || !raw.trimEnd().endsWith('end_of_record')) throw Error('LCOV capture is incomplete');
const tested = git('rev-parse', '--verify', coverageRevision + '^{commit}');
const changed = new Set(git('diff', '--name-only', tested, '--', 'api/src').split('\n'));
for (const row of entries) {
  if (row.issue) continue;
  if (changed.has(row.registration.split(':')[0]) || changed.has(row.file)) { row.issue = 'source-changed-since-coverage'; continue; }
  if (!records.has(row.file)) { row.issue = 'source-absent'; continue; }
  const { byLine, lineCounts } = records.get(row.file);
  // This diagnostic is never promoted to a function hit. Select only a direct,
  // executable statement on a separate line within the handler's braces.
  if (ts.isBlock(row.body.body)) {
    const block = row.body.body;
    const st = block.statements.find(s => !ts.isFunctionDeclaration(s) && !ts.isClassDeclaration(s) &&
      !ts.isInterfaceDeclaration(s) && !ts.isTypeAliasDeclaration(s) && startLine(s) > startLine(block) &&
      startLine(s) < s.getSourceFile().getLineAndCharacterOfPosition(block.end).line + 1 &&
      lineCounts.has(startLine(s)));
    if (st) row.lineDiagnostic = startLine(st) + '=' + lineCounts.get(startLine(st));
  }
  const ds = byLine.get(row.line) ?? [];
  if (!ds.length) { row.issue = 'no-function-counter'; continue; }
  if (ds.length !== 1 || indexFile(row.file).functions.get(row.line)?.length !== 1) {
    row.issue = 'ambiguous-function-line'; continue;
  }
  row.counter = ds[0];
}
const columns = ['Family','HTTP operation','Registration','Callback kind','Reference or factory call','Handler start','Fastify role','Operations sharing body','Function counter','Calls','First direct body line=DA (diagnostic)','Evidence'];
const result = [columns];
for (const r of entries) {
  const shared = r.body ? groups.get(r.body).length : '';
  const status = r.issue ?? (r.counter.count ? (shared === 1 ? 'body-entered' : 'shared-body-entered') : 'body-zero');
  result.push([r.family,r.operation,r.registration,r.shape,r.binding,r.body ? r.file + ':' + r.line : '',r.role,shared,r.counter?.name,r.counter?.count,r.lineDiagnostic,status]);
}
fs.writeFileSync(output, result.map(row => row.map(x => x ?? '').join('\t')).join('\n') + '\n');
const totals = {};
for (const row of result.slice(1)) totals[row.at(-1)] = (totals[row.at(-1)] || 0) + 1;
console.log(JSON.stringify({tested, inventory_sha256:sha256(inventory), lcov_sha256:sha256(raw), operations:entries.length,
  unique_resolved_bodies:groups.size, entered_bodies:[...groups.keys()].filter(fn => groups.get(fn)[0].counter?.count > 0).length, totals}, null, 2));
