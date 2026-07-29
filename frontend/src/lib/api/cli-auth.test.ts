import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// `cli-auth.ts` imports the real API client for its request helpers; the two
// pure code helpers under test never touch it, so a bare stub is enough to
// make the module importable.
const CLIENT_STUB = "stub:api-client";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === CLIENT_STUB) {
      return { format: "module", shortCircuit: true, source: "export const api = {};" };
    }
    return nextLoad(url, context);
  },
});

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const cliAuthModule: string = "./cli-auth.ts";
const { isCodeComplete, normalizeCode } = (await import(
  cliAuthModule
)) as typeof import("./cli-auth");

describe("normalizeCode", () => {
  it("uppercases lowercase input", () => {
    assert.equal(normalizeCode("wxyz2345"), "WXYZ-2345");
    assert.equal(normalizeCode("wxy"), "WXY");
  });

  it("strips punctuation and whitespace", () => {
    assert.equal(normalizeCode("  wx yz 23 45  "), "WXYZ-2345");
    assert.equal(normalizeCode("W.X/Y*Z_2:3;4,5"), "WXYZ-2345");
  });

  it("returns four or fewer cleaned characters without a hyphen", () => {
    assert.equal(normalizeCode(""), "");
    assert.equal(normalizeCode("---"), "");
    assert.equal(normalizeCode("w"), "W");
    assert.equal(normalizeCode("w-x-y-z"), "WXYZ");
  });

  it("hyphenates after the fourth character", () => {
    assert.equal(normalizeCode("WXYZ2"), "WXYZ-2");
    assert.equal(normalizeCode("WXYZ234"), "WXYZ-234");
    assert.equal(normalizeCode("WXYZ2345"), "WXYZ-2345");
  });

  it("truncates anything past eight cleaned characters", () => {
    assert.equal(normalizeCode("WXYZ23456"), "WXYZ-2345");
    assert.equal(normalizeCode("WXYZ-2345-6789"), "WXYZ-2345");
  });

  it("round-trips an already-hyphenated code unchanged", () => {
    assert.equal(normalizeCode("WXYZ-2345"), "WXYZ-2345");
    assert.equal(normalizeCode(normalizeCode("wxyz 2345")), "WXYZ-2345");
  });
});

describe("isCodeComplete", () => {
  it("accepts the canonical AAAA-9999 form", () => {
    assert.equal(isCodeComplete("WXYZ-2345"), true);
  });

  it("rejects incomplete, unnormalized or over-long forms", () => {
    assert.equal(isCodeComplete(""), false);
    assert.equal(isCodeComplete("WXY-2345"), false, "three letters");
    assert.equal(isCodeComplete("WXYZ-234"), false, "three digits");
    assert.equal(isCodeComplete("wxyz-2345"), false, "lowercase");
    assert.equal(isCodeComplete("WXYZ2345"), false, "no hyphen");
    assert.equal(isCodeComplete("WXY2-345Z"), false, "digit in a letter slot");
    assert.equal(isCodeComplete("WXYZ-23456"), false, "five digits");
  });
});

// The server hashes the exact string it issued, so `isCodeComplete` has to
// accept — and `normalizeCode` has to leave alone — every code
// `generateUserCode` can produce. Read the issuing alphabets out of the
// service instead of restating them here, so a change on either side surfaces
// as a failure rather than as pairing codes nobody can enter.
describe("parity with the server code alphabet", () => {
  const serviceFile = fileURLToPath(
    new URL("../../../../api/src/services/cli-auth.ts", import.meta.url),
  );
  const source = readFileSync(serviceFile, "utf8");

  /** The characters of `const <name> = '...'` in the CLI auth service. */
  function alphabet(name: string): string {
    const match = source.match(new RegExp(`\\bconst ${name}\\s*=\\s*['"]([^'"]+)['"]`));
    if (!match) {
      assert.fail(`no \`const ${name}\` in ${serviceFile}: the client code shape is now unpinned`);
    }
    return match[1];
  }

  const ALPHA = alphabet("ALPHA");
  const DIGITS = alphabet("DIGITS");

  it("found both issuing alphabets", () => {
    assert.match(ALPHA, /^[A-Z]{2,}$/, `ALPHA=${ALPHA}`);
    assert.match(DIGITS, /^[0-9]{2,}$/, `DIGITS=${DIGITS}`);
  });

  it("accepts every letter the server can issue", () => {
    for (const letter of ALPHA) {
      const code = `${letter.repeat(4)}-${DIGITS[0].repeat(4)}`;
      assert.equal(normalizeCode(code), code, `normalizeCode altered ${code}`);
      assert.equal(isCodeComplete(code), true, `isCodeComplete rejected ${code}`);
    }
  });

  it("accepts every digit the server can issue", () => {
    for (const digit of DIGITS) {
      const code = `${ALPHA[0].repeat(4)}-${digit.repeat(4)}`;
      assert.equal(normalizeCode(code), code, `normalizeCode altered ${code}`);
      assert.equal(isCodeComplete(code), true, `isCodeComplete rejected ${code}`);
    }
  });
});
