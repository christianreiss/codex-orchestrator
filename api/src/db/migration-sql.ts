/**
 * Statement splitter for the hand-written SQL in `migrations/`.
 *
 * `mysql2` sends one statement per query (`multipleStatements` stays off, and
 * turning it on would open the door to statement injection), so the runner has
 * to do what the `mysql` CLI does before it can apply a file: drop comments,
 * respect quoting, and honour `DELIMITER`. That last one is a *client*
 * directive the server has never heard of — `0005_add_auth_generation_ledger.sql`
 * needs it to define a stored procedure whose body contains semicolons, and a
 * naive `split(';')` produces garbage for exactly that file.
 */

/** `DELIMITER x` must own its line, same as in the `mysql` client. */
const DELIMITER_DIRECTIVE = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i;

export function splitSqlStatements(text: string): string[] {
  const statements: string[] = [];
  let delimiter = ';';
  let buffer = '';
  let index = 0;
  let lineStart = true;

  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) statements.push(trimmed);
    buffer = '';
  };

  while (index < text.length) {
    if (lineStart && buffer.trim().length === 0) {
      const directive = DELIMITER_DIRECTIVE.exec(text.slice(index));
      if (directive) {
        delimiter = directive[1]!;
        buffer = '';
        index += directive[0].length;
        lineStart = true;
        continue;
      }
    }

    const char = text[index]!;
    const next = text[index + 1];

    // `--` only opens a comment when whitespace or EOL follows it; `1--2` is a
    // pair of unary minuses. `#` always opens one.
    if (char === '#' || (char === '-' && next === '-' && isSpaceOrEnd(text[index + 2]))) {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline + 1;
      buffer += '\n'; // keep the line break so dropping a comment cannot glue tokens
      lineStart = true;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      // `/*! … */` is a MySQL executable comment: the server decides whether to
      // run its body, so forward it verbatim instead of stripping it.
      buffer += text[index + 2] === '!' ? text.slice(index, stop) : ' ';
      index = stop;
      lineStart = false;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const end = endOfQuoted(text, index);
      buffer += text.slice(index, end);
      index = end;
      lineStart = false;
      continue;
    }

    if (text.startsWith(delimiter, index)) {
      flush();
      index += delimiter.length;
      lineStart = false;
      continue;
    }

    buffer += char;
    lineStart = char === '\n';
    index += 1;
  }

  // Trailing statement without a delimiter, same as the CLI's implicit flush.
  flush();
  return statements;
}

function isSpaceOrEnd(char: string | undefined): boolean {
  return char === undefined || char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/**
 * Index one past the closing quote. Handles backslash escapes (not applicable
 * to backtick identifiers) and the doubled-quote form — `''legacy''` in 0005.
 * An unterminated literal runs to EOF so MySQL, not this splitter, reports the
 * syntax error with its own line/column.
 */
function endOfQuoted(text: string, start: number): number {
  const quote = text[start]!;
  let index = start + 1;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\' && quote !== '`') {
      index += 2;
      continue;
    }
    if (char === quote) {
      if (text[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}
