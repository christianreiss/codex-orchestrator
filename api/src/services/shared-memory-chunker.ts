/**
 * Pure chunking for `shared_memories`.
 *
 * Shared memories are documents, not facts — up to 1 MiB of markdown. Handing a
 * whole one back to an agent is a context bomb, and indexing it as a single
 * FULLTEXT row makes every hit rank the same. So the indexed unit is a chunk:
 * a few paragraphs, tagged with the markdown heading breadcrumb it lives under.
 *
 * Two invariants the rest of the service relies on, both covered by tests:
 *   1. Chunks tile the document exactly — `chunks[0].charStart === 0`, each
 *      chunk's `charEnd` is the next one's `charStart`, and the last chunk ends
 *      at `content.length`. Joining every `content` reproduces the input byte
 *      for byte. That is what makes a chunk range also a character range.
 *   2. Splits land on structural boundaries where possible (heading, then blank
 *      line, then newline, then whitespace) and only fall back to a hard cut
 *      inside a very long unbroken run.
 */

/** Preferred chunk size. Splits are taken at the first boundary at or past this. */
export const CHUNK_TARGET_CHARS = 2000;
/** Hard ceiling for one chunk; a boundary is forced at or before this. */
export const CHUNK_MAX_CHARS = 4000;
/**
 * A heading only forces a break once the current chunk has this much text.
 * Without it a document of many small sections produces one chunk per heading,
 * which is both slower to search and worse to read.
 */
export const CHUNK_MIN_CHARS = 512;
/**
 * Budget for *structural* splitting. Past this many chunks the splitter stops
 * looking for heading boundaries and falls back to fixed-size slices, which
 * bounds the cost of a pathological input (e.g. 200k single-character heading
 * lines) without ever emitting an oversized chunk. It is deliberately NOT a cap
 * on the number of chunks: an earlier version made the remainder one final
 * chunk, which blew past CHUNK_MAX_CHARS and overflowed the TEXT column storing
 * it, failing the write for a document well under the 1 MiB content limit.
 */
export const MAX_CHUNKS = 1024;

const ATX_HEADING = /^(#{1,6})[ \t]+(\S.*?)[ \t]*#*[ \t]*$/;
const MAX_HEADING_LEN = 255;

export interface Chunk {
  ordinal: number;
  /** Breadcrumb of the markdown headings this chunk sits under, e.g. `Deploy > Crane`. */
  heading: string | null;
  content: string;
  charStart: number;
  charEnd: number;
}

interface HeadingMark {
  offset: number;
  level: number;
  text: string;
}

/**
 * Line starts plus the ATX headings found, in one pass. Offsets are absolute
 * character offsets into `content`.
 */
function scan(content: string): { lineStarts: number[]; headings: HeadingMark[] } {
  const lineStarts: number[] = [0];
  const headings: HeadingMark[] = [];
  let lineStart = 0;
  const len = content.length;
  for (let i = 0; i <= len; i++) {
    if (i === len || content.charCodeAt(i) === 10 /* \n */) {
      const raw = content.slice(lineStart, i);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const m = ATX_HEADING.exec(line);
      if (m && m[1] && m[2]) {
        headings.push({ offset: lineStart, level: m[1].length, text: m[2].trim() });
      }
      if (i < len) {
        lineStart = i + 1;
        lineStarts.push(lineStart);
      }
    }
  }
  return { lineStarts, headings };
}

/**
 * Best split offset in `(from, hardLimit]`, preferring structure. Returns null
 * when no boundary exists (caller then hard-cuts).
 */
function findBreak(content: string, lineStarts: number[], from: number, softLimit: number, hardLimit: number): number | null {
  // Blank line at or after the soft limit, else the last blank line before the
  // hard limit. `lineStarts` is sorted, so a linear walk from the first line
  // start past `from` is enough — the window is bounded by CHUNK_MAX_CHARS.
  let lastBlankBeforeHard: number | null = null;
  let lastNewlineBeforeHard: number | null = null;
  let idx = lowerBound(lineStarts, from + 1);
  for (; idx < lineStarts.length; idx++) {
    const start = lineStarts[idx]!;
    if (start > hardLimit) break;
    const prev = content.slice(lineStarts[idx - 1] ?? from, start).trim();
    const isBlankBoundary = prev === '';
    if (start >= softLimit) {
      if (isBlankBoundary) return start;
      // Remember the first newline past the soft limit as a second choice.
      if (lastNewlineBeforeHard === null || lastNewlineBeforeHard < softLimit) lastNewlineBeforeHard = start;
    } else {
      if (isBlankBoundary) lastBlankBeforeHard = start;
      lastNewlineBeforeHard = start;
    }
  }
  if (lastNewlineBeforeHard !== null && lastNewlineBeforeHard >= softLimit) return lastNewlineBeforeHard;
  if (lastBlankBeforeHard !== null && lastBlankBeforeHard > from) return lastBlankBeforeHard;
  if (lastNewlineBeforeHard !== null && lastNewlineBeforeHard > from) return lastNewlineBeforeHard;
  // No line boundary in range: fall back to the last whitespace run.
  for (let i = Math.min(hardLimit, content.length) - 1; i > from + 1; i--) {
    const c = content.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) return i + 1;
  }
  return null;
}

/** First index into a sorted array whose value is >= `value`. */
function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Split `content` into indexable chunks. An empty document yields a single
 * empty chunk so that every stored memory has at least one searchable row and
 * `chunk_count` is never 0 for a live document.
 */
export function chunkContent(content: string): Chunk[] {
  const { lineStarts, headings } = scan(content);
  const chunks: Chunk[] = [];
  const len = content.length;
  if (len === 0) {
    return [{ ordinal: 0, heading: null, content: '', charStart: 0, charEnd: 0 }];
  }

  let start = 0;
  // Cursors into `headings`, advanced monotonically as `start` moves forward.
  // Rescanning the heading array from index 0 for every chunk (both to find the
  // next break and to rebuild the breadcrumb) made a heading-dense 1 MiB
  // document quadratic — ~285 ms of blocked event loop, measured.
  let headingCursor = 0;
  let crumbCursor = 0;
  const crumbStack: HeadingMark[] = [];
  const crumbAt = (offset: number): string | null => {
    while (crumbCursor < headings.length && headings[crumbCursor]!.offset <= offset) {
      const h = headings[crumbCursor]!;
      while (crumbStack.length > 0 && crumbStack[crumbStack.length - 1]!.level >= h.level) crumbStack.pop();
      crumbStack.push(h);
      crumbCursor++;
    }
    if (crumbStack.length === 0) return null;
    let crumb = crumbStack.map((h) => h.text).join(' > ');
    if (crumb.length > MAX_HEADING_LEN) crumb = crumb.slice(0, MAX_HEADING_LEN - 1) + '…';
    return crumb || null;
  };
  while (start < len) {
    const softLimit = Math.min(start + CHUNK_TARGET_CHARS, len);
    const hardLimit = Math.min(start + CHUNK_MAX_CHARS, len);

    let end: number | null = null;
    if (chunks.length < MAX_CHUNKS - 1) {
      // A heading past the minimum size wins over size-based splitting: sections
      // are the most useful boundary a markdown document offers.
      while (headingCursor < headings.length && headings[headingCursor]!.offset <= start) headingCursor++;
      for (let i = headingCursor; i < headings.length; i++) {
        const h = headings[i]!;
        if (h.offset > hardLimit) break;
        if (h.offset - start >= CHUNK_MIN_CHARS) {
          end = h.offset;
          break;
        }
      }
    }
    // Past the structural budget the loop keeps running, but only as fixed-size
    // slices. Emitting "all the rest" as one chunk (the original backstop) blew
    // past CHUNK_MAX_CHARS and overflowed the TEXT column that stores it, which
    // failed the whole write for a document that was under the 1 MiB limit.
    // Every chunk this function returns is <= CHUNK_MAX_CHARS, always.

    if (end === null) {
      if (hardLimit >= len) {
        end = len;
      } else {
        end = findBreak(content, lineStarts, start, softLimit, hardLimit) ?? hardLimit;
      }
    }
    if (end <= start) end = Math.min(start + CHUNK_MAX_CHARS, len);
    // Never cut between the halves of a surrogate pair: the two chunks would
    // each hold a lone surrogate, which MySQL stores as U+FFFD, silently
    // corrupting the character on a round-trip through the chunk table.
    // Move the split back so the pair travels together in the next chunk, which
    // keeps the chunk at or under CHUNK_MAX_CHARS; only push it forward when
    // moving back would produce an empty chunk.
    if (end < len && isHighSurrogate(content.charCodeAt(end - 1)) && isLowSurrogate(content.charCodeAt(end))) {
      end = end - 1 > start ? end - 1 : end + 1;
    }

    chunks.push({
      ordinal: chunks.length,
      heading: crumbAt(start),
      content: content.slice(start, end),
      charStart: start,
      charEnd: end,
    });
    start = end;
  }

  return chunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Collapse whitespace and clip to `max` characters — used for list previews and
 * for the fallback excerpt when a query term cannot be located in a chunk.
 */
export function preview(content: string, max = 240): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Excerpt a chunk around the first query term that appears in it, so a search
 * hit shows the matching text rather than whichever sentence happens to start
 * the chunk. Falls back to a leading preview when nothing matches (FULLTEXT
 * ranks on stems and proximity, so a hit need not contain the literal term).
 */
export function excerptFor(content: string, query: string, max = 320): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);
  const haystack = flat.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    const idx = haystack.indexOf(term);
    if (idx !== -1) {
      hit = idx;
      break;
    }
  }
  if (hit === -1) return preview(flat, max);
  const half = Math.floor((max - 20) / 2);
  let from = Math.max(0, hit - half);
  let to = Math.min(flat.length, from + max);
  from = Math.max(0, to - max);
  // Avoid starting or ending mid-word when we are not at a document edge.
  if (from > 0) {
    const space = flat.indexOf(' ', from);
    if (space !== -1 && space - from < 24) from = space + 1;
  }
  if (to < flat.length) {
    const space = flat.lastIndexOf(' ', to);
    if (space !== -1 && to - space < 24) to = space;
  }
  return (from > 0 ? '…' : '') + flat.slice(from, to).trim() + (to < flat.length ? '…' : '');
}
