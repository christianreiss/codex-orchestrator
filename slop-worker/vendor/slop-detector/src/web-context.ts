/** Narrow static context for two web heuristics; uncertain/dynamic cases stay reviewable. */
export function explainedWebSignals(text: string): Map<string, Set<number>> {
  const focus = new Set<number>(), backdrop = new Set<number>();
  // A replacement must belong to the same literal class attribute, including
  // multiline attributes. A neighbouring element or conditional class is no proof.
  for (const tag of text.matchAll(/<[A-Za-z][\w:.-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g)) {
    for (const attr of tag[0].matchAll(/\s(?:class|className)\s*=\s*(["'])([\s\S]*?)\1/g)) {
      const classes = attr[2];
      if (/[{}]/.test(classes)) continue;
      const tokens = classes.split(/\s+/);
      const rings = tokens.flatMap((token) => token.match(/(?:^|:)ring-(.*)$/)?.slice(1) ?? []);
      // Width alone cannot restore outline style/color after outline-none
      // (Tailwind versions differ). Keep outline-only replacements reviewable.
      // Likewise, arbitrary ring values or unknown alpha need rendered evidence.
      const uncertainRing = rings.some((value) =>
        /^(?:0|transparent|opacity-0)(?:$|\/)/.test(value) || /[\[\]()]/.test(value) ||
        (value.includes("/") && !/\/(?:[1-9]\d?|100)$/.test(value)));
      if (uncertainRing || !tokens.some((token) => /^focus(?:-visible)?:ring-[1248]$/.test(token))) continue;
      const start = tag.index! + attr.index! + attr[0].indexOf(attr[1]) + 1;
      for (const match of classes.matchAll(/outline-none/g)) focus.add(start + match.index!);
    }
  }
  // Only a declaration in an exclusively native dialog backdrop block is
  // explained. Mixed selectors, other containers and other rules keep findings.
  const css = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
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
