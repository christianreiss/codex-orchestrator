import assert from "node:assert/strict";
import { describe, it } from "node:test";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const passwordModule: string = "./password.ts";
const {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_TEXT,
  PASSWORD_RULES,
  isValidPassword,
  passwordSchema,
} = (await import(passwordModule)) as typeof import("./password");

const [LENGTH_RULE, MIX_RULE] = PASSWORD_RULES;

/** Six characters of each class the mix rule counts. */
const CLASSES: { name: string; sample: string }[] = [
  { name: "lowercase", sample: "abcdef" },
  { name: "uppercase", sample: "GHIJKL" },
  { name: "digit", sample: "123456" },
  { name: "symbol", sample: "!@#$%^" },
];

/** `length` characters, all from `sample`'s class. */
const runOf = (sample: string, length: number): string => sample.repeat(length).slice(0, length);

/** Long enough for the length rule, but a single class short for the mix rule. */
const singleClass = (sample: string): string => runOf(sample, PASSWORD_MIN_LENGTH);

/** Long enough, all of `first`'s class but for one character of `second`'s. */
const twoClasses = (first: string, second: string): string =>
  runOf(first, PASSWORD_MIN_LENGTH - 1) + second[0];

// The same lowercase-and-digit mix either side of the boundary: 11 and 12
// characters while the minimum is 12.
const TOO_SHORT = runOf("abcdef", PASSWORD_MIN_LENGTH - 2) + "1";
const AT_MINIMUM = twoClasses("abcdef", "123456");

/** Every unordered pair of classes, mixed into one password. */
const PAIRINGS: { name: string; value: string }[] = CLASSES.flatMap((first, index) =>
  CLASSES.slice(index + 1).map((second) => ({
    name: `${first.name} + ${second.name}`,
    value: twoClasses(first.sample, second.sample),
  })),
);

/** The messages `passwordSchema` rejects `value` with, in the order it emits them. */
const issues = (value: string): string[] => {
  const parsed = passwordSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("PASSWORD_RULES", () => {
  it("rejects one character below the minimum and accepts it at the minimum", () => {
    assert.equal(TOO_SHORT.length, PASSWORD_MIN_LENGTH - 1);
    assert.equal(AT_MINIMUM.length, PASSWORD_MIN_LENGTH);
    assert.equal(LENGTH_RULE.test(TOO_SHORT), false);
    assert.equal(LENGTH_RULE.test(AT_MINIMUM), true);
    assert.equal(isValidPassword(TOO_SHORT), false);
    assert.equal(isValidPassword(AT_MINIMUM), true);
  });

  it("rejects a long password drawn from a single character class", () => {
    for (const { name, sample } of CLASSES) {
      const value = singleClass(sample);
      // Length is not what these fail on: only the mix rule may object.
      assert.equal(LENGTH_RULE.test(value), true, name);
      assert.equal(MIX_RULE.test(value), false, name);
      assert.equal(isValidPassword(value), false, name);
    }
  });

  it("accepts every pairing of two character classes", () => {
    assert.equal(PAIRINGS.length, 6);
    for (const { name, value } of PAIRINGS) {
      assert.equal(isValidPassword(value), true, name);
    }
  });
});

describe("passwordSchema", () => {
  it("reports both rules for the empty string", () => {
    assert.deepEqual(issues(""), [LENGTH_RULE.label, MIX_RULE.label]);
  });

  it("reports only the rule the password breaks", () => {
    assert.deepEqual(issues(TOO_SHORT), [LENGTH_RULE.label]);
    assert.deepEqual(issues(singleClass("abcdef")), [MIX_RULE.label]);
  });

  it("reports nothing for a compliant password", () => {
    assert.equal(passwordSchema.safeParse(AT_MINIMUM).success, true);
    assert.deepEqual(issues(AT_MINIMUM), []);
  });
});

describe("PASSWORD_POLICY_TEXT", () => {
  it("states the minimum the rules enforce", () => {
    // The dialog prints this sentence next to a box the rules above police; a
    // minimum that moves without it turns compliance into a guess.
    assert.match(PASSWORD_POLICY_TEXT, new RegExp(`\\b${PASSWORD_MIN_LENGTH}\\b`));
  });
});

describe("create and edit paths", () => {
  it("agree on every candidate", () => {
    // `userSchema.ts` validates the create form through `passwordSchema` and the
    // edit form through `isValidPassword`, so a password an owner sets for a user
    // must never be one that same user is refused when they later change it.
    const candidates: string[] = [
      "",
      " ",
      TOO_SHORT,
      AT_MINIMUM,
      "correct-horse-9",
      ...CLASSES.map((klass) => singleClass(klass.sample)),
      ...PAIRINGS.map((pairing) => pairing.value),
    ];
    for (const value of candidates) {
      assert.equal(
        isValidPassword(value),
        passwordSchema.safeParse(value).success,
        JSON.stringify(value),
      );
    }
  });
});
