import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

// `userSchema.ts` reaches its role list and password policy through SvelteKit's
// `$lib` alias, which node cannot resolve; pointing those specifiers at the real
// files keeps the module importable without a bundler.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("$lib/")) {
      return nextResolve(new URL(`../../${specifier.slice("$lib/".length)}.ts`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const schemaModule: string = "./userSchema.ts";
const { createUserSchema } = (await import(schemaModule)) as typeof import("./userSchema");

type FormValues = Record<string, unknown>;

/** What the dialog submits when every box is filled in acceptably. */
const VALID: FormValues = {
  name: "Ada Lovelace",
  username: "ada.lovelace",
  email: "ada@example.com",
  access_level: "admin",
  active: true,
  password: "correct-horse-9",
  password_confirm: "correct-horse-9",
};

const payload = (overrides: FormValues = {}): FormValues => ({ ...VALID, ...overrides });

/**
 * Fields `createUserSchema` rejects `input` on, deduplicated the way the dialog
 * shows them: one message per box, however many rules that box broke.
 */
function rejectedFields(input: FormValues): string[] {
  const parsed = createUserSchema.safeParse(input);
  if (parsed.success) return [];
  return [...new Set(parsed.error.issues.map((issue) => issue.path[0]?.toString() ?? "_"))];
}

describe("createUserSchema", () => {
  it("accepts a fully populated payload", () => {
    const data = createUserSchema.parse(payload({ name: "  Ada Lovelace  " }));
    assert.equal(data.name, "Ada Lovelace");
    assert.equal(data.username, "ada.lovelace");
    assert.equal(data.email, "ada@example.com");
    assert.equal(data.access_level, "admin");
  });

  it("rejects a blank or whitespace-only name", () => {
    // The API's normalizeName throws on both, so neither may reach it.
    assert.deepEqual(rejectedFields(payload({ name: "" })), ["name"]);
    assert.deepEqual(rejectedFields(payload({ name: "   " })), ["name"]);
  });

  it("rejects a blank or malformed email", () => {
    assert.deepEqual(rejectedFields(payload({ email: "" })), ["email"]);
    assert.deepEqual(rejectedFields(payload({ email: "   " })), ["email"]);
    assert.deepEqual(rejectedFields(payload({ email: "ada@example" })), ["email"]);
  });

  it("rejects a username under three characters or outside the alphabet", () => {
    assert.deepEqual(rejectedFields(payload({ username: "ad" })), ["username"]);
    assert.deepEqual(rejectedFields(payload({ username: "Ada.Lovelace" })), ["username"]);
    assert.deepEqual(rejectedFields(payload({ username: "ada lovelace" })), ["username"]);
  });

  it("rejects a password the confirmation does not repeat", () => {
    assert.deepEqual(
      rejectedFields(payload({ password_confirm: "correct-horse-8" })),
      ["password_confirm"],
    );
  });
});
