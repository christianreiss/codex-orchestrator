/**
 * Line-based unified diff (Myers, O((N+M)·D)) for slop job file revisions.
 * Bounded: callers refuse inputs over MAX_DIFF_LINES rather than spending
 * unbounded CPU on a request thread.
 */
export const MAX_DIFF_LINES = 20_000;

type Op = { type: ' ' | '-' | '+'; line: string; a: number; b: number };

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function myers(a: string[], b: string[]): Op[] {
  const n = a.length,
    m = b.length,
    max = n + m,
    offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  const ops: Op[] = [];
  let x = n,
    y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!,
      k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : vd[offset + prevK]!,
      prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: ' ', line: a[x - 1]!, a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ type: '+', line: b[y - 1]!, a: x, b: y - 1 });
    else ops.push({ type: '-', line: a[x - 1]!, a: x - 1, b: y });
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface UnifiedDiff {
  diff: string;
  added: number;
  removed: number;
}

export function unifiedDiff(before: string, after: string, fromLabel: string, toLabel: string, context = 3): UnifiedDiff {
  const a = splitLines(before),
    b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES)
    throw new RangeError(`diff inputs are limited to ${MAX_DIFF_LINES} lines`);
  const ops = myers(a, b);
  const added = ops.filter((op) => op.type === '+').length,
    removed = ops.filter((op) => op.type === '-').length;
  if (!added && !removed) return { diff: '', added, removed };
  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.type === ' ') {
      i++;
      continue;
    }
    let start = Math.max(0, i - context),
      end = i;
    // Extend the hunk while changes are within 2*context lines of each other.
    for (let j = i; j < ops.length; j++) {
      if (ops[j]!.type !== ' ') end = j;
      else if (j - end > 2 * context) break;
    }
    end = Math.min(ops.length - 1, end + context);
    const hunk = ops.slice(start, end + 1);
    const aStart = hunk.find((op) => op.type !== '+')?.a ?? hunk[0]!.a,
      bStart = hunk.find((op) => op.type !== '-')?.b ?? hunk[0]!.b;
    const aLen = hunk.filter((op) => op.type !== '+').length,
      bLen = hunk.filter((op) => op.type !== '-').length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const op of hunk) out.push(`${op.type}${op.line}`);
    i = end + 1;
    start = i;
  }
  return { diff: `${out.join('\n')}\n`, added, removed };
}
