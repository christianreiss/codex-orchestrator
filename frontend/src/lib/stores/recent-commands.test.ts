import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, beforeEach, describe, it } from "node:test";

// `recent-commands.ts` imports the SvelteKit virtual module `$app/environment`,
// which node cannot resolve on its own; answering it with a stub keeps
// `browser` true (so every storage path actually runs) and lets the
// server-side case flip it back off.
const ENV_STUB = "stub:app-environment";

/** `browser` is a live binding, so flipping it here reaches the store too. */
const envStubSource = `
export let browser = true;
export function setBrowser(value) {
  browser = value;
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "$app/environment") return { url: ENV_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === ENV_STUB) {
      return { format: "module", shortCircuit: true, source: envStubSource };
    }
    return nextLoad(url, context);
  },
});

const STORAGE_KEY = "codex:recent-commands";

/** Stand-in for `localStorage` whose access can fail the way a blocked origin does. */
class FakeStorage {
  values = new Map<string, string>();
  failReads = false;
  failWrites = false;

  getItem(key: string): string | null {
    if (this.failReads) throw new Error("SecurityError: storage is blocked");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.values.set(key, value);
  }
}

const storage = new FakeStorage();

Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
  writable: true,
});

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const envModule: string = ENV_STUB;
const { setBrowser } = (await import(envModule)) as { setBrowser: (value: boolean) => void };

const storeModule: string = "./recent-commands.ts";
const { getRecentCommandIds, recordRecentCommand } = (await import(
  storeModule
)) as typeof import("./recent-commands");

/** What the store actually persisted, straight off the fake storage. */
function persisted(): unknown {
  const raw = storage.values.get(STORAGE_KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

beforeEach(() => {
  storage.values.clear();
  storage.failReads = false;
  storage.failWrites = false;
});

describe("recordRecentCommand", () => {
  it("prepends a newly invoked id", () => {
    recordRecentCommand("hosts");
    recordRecentCommand("agents");
    assert.deepEqual(persisted(), ["agents", "hosts"]);
  });

  it("moves an already-recorded id to the front instead of duplicating it", () => {
    storage.values.set(STORAGE_KEY, JSON.stringify(["hosts", "agents", "tasks"]));
    recordRecentCommand("agents");
    assert.deepEqual(persisted(), ["agents", "hosts", "tasks"]);
  });

  it("caps the list at five entries, dropping the oldest", () => {
    for (const id of ["one", "two", "three", "four", "five", "six"]) {
      recordRecentCommand(id);
    }
    assert.deepEqual(persisted(), ["six", "five", "four", "three", "two"]);
  });
});

describe("getRecentCommandIds", () => {
  it("is empty when nothing was ever stored", () => {
    assert.deepEqual(getRecentCommandIds(), []);
  });

  it("is empty when the stored payload is not JSON", () => {
    storage.values.set(STORAGE_KEY, "{not json");
    assert.deepEqual(getRecentCommandIds(), []);
  });

  it("is empty when the stored payload is not an array", () => {
    storage.values.set(STORAGE_KEY, JSON.stringify({ hosts: 1 }));
    assert.deepEqual(getRecentCommandIds(), []);
  });

  it("drops non-string members of a hand-edited array", () => {
    storage.values.set(
      STORAGE_KEY,
      JSON.stringify(["hosts", 2, null, "agents", { id: "tasks" }, true, "runs"]),
    );
    assert.deepEqual(getRecentCommandIds(), ["hosts", "agents", "runs"]);
  });
});

describe("storage that throws", () => {
  it("reads as empty rather than crashing the palette", () => {
    storage.values.set(STORAGE_KEY, JSON.stringify(["hosts"]));
    storage.failReads = true;
    assert.deepEqual(getRecentCommandIds(), []);
  });

  it("records nothing and stays silent", () => {
    storage.failReads = true;
    storage.failWrites = true;
    assert.doesNotThrow(() => recordRecentCommand("hosts"));
    assert.equal(storage.values.size, 0);
  });
});

describe("on the server", () => {
  before(() => setBrowser(false));
  after(() => setBrowser(true));

  it("reads as empty without touching storage", () => {
    storage.values.set(STORAGE_KEY, JSON.stringify(["hosts"]));
    assert.deepEqual(getRecentCommandIds(), []);
  });

  it("records nothing", () => {
    recordRecentCommand("hosts");
    assert.equal(storage.values.size, 0);
  });
});
