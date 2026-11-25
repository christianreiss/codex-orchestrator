/** Recognize utility classes that carry their own visible replacement ring. */
function recordFocusClasses(focus: Set<number>, classes: string, start: number) {
  if (/[{}\\]/.test(classes)) return;
  const tokens = classes.split(/\s+/);
  const rings = tokens.flatMap((token) => token.match(/(?:^|:)ring-(.*)$/)?.slice(1) ?? []);
  // Outline width alone does not restore style/color. Arbitrary ring values
  // and uncertain or zero alpha require rendered evidence.
  const uncertainRing = rings.some((value) =>
    /^(?:0|transparent|opacity-0)(?:$|\/)/.test(value) || /[\[\]()]/.test(value) ||
    (value.includes("/") && !/\/(?:[1-9]\d?|100)$/.test(value)));
  if (uncertainRing || !tokens.some((token) => /^focus(?:-visible)?:ring-[1248]$/.test(token))) return;

  for (const match of classes.matchAll(/(?:^|\s)(?:[\w-]+:)*outline-none(?=\s|$)/g)) {
    focus.add(start + match.index! + match[0].lastIndexOf("outline-none"));
  }
}

/** Narrow static context for two web heuristics; uncertain/dynamic cases stay reviewable. */
export function explainedWebSignals(text: string): Map<string, Set<number>> {
  const focus = new Set<number>(), backdrop = new Set<number>();
  // HTML attributes may span lines that ordinary source string literals cannot.
  for (const tag of text.matchAll(/<[A-Za-z][\w:.-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g)) {
    for (const attr of tag[0].matchAll(/\s(?:class|className)\s*=\s*(["'])([\s\S]*?)\1/g)) {
      const start = tag.index! + attr.index! + attr[0].indexOf(attr[1]) + 1;
      recordFocusClasses(focus, attr[2], start);
    }
  }
  // Each literal stands alone: a separate argument, array item or conditional
  // branch cannot establish a ring for an outline removal in another literal.
  const literalOrComment = /("(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g;
  for (const match of text.matchAll(literalOrComment)) {
    if (match[1]) recordFocusClasses(focus, match[1].slice(1, -1), match.index! + 1);
  }

  const css = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  for (const apply of css.matchAll(/@apply(\s+[^;{}]+);/g)) {
    recordFocusClasses(focus, apply[1], apply.index! + "@apply".length);
  }
  // Only a declaration in an exclusively native dialog backdrop block is
  // explained. Mixed selectors, other containers and other rules keep findings.
  const dialog = /^dialog(?:[.#][\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?)*::backdrop$/;
  const blocks: Array<{ selector: string; start: number; nested: boolean }> = [];
  let previous = 0;
  for (const brace of css.matchAll(/[{}]/g)) {
    const index = brace.index!;
    if (brace[0] === "{") {
      if (blocks.length) blocks[blocks.length - 1].nested = true;
      blocks.push({ selector: css.slice(previous, index), start: index + 1, nested: false });
    } else {
      const block = blocks.pop();
      if (block && !block.nested) {
        const selector = block.selector.split(/<\/?style\b[^>]*>/).at(-1)!.trim();
        if (selector.split(",").every((part) => dialog.test(part.trim()))) {
          for (const match of css.slice(block.start, index).matchAll(/\bbackdrop-filter\s*:/g))
            backdrop.add(block.start + match.index!);
        }
      }
    }
    previous = index + 1;
  }
  return new Map([["focus", focus], ["card-kit", backdrop]]);
}
