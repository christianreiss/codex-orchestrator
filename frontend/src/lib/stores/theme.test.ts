import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

// `theme.ts` imports the SvelteKit virtual module `$app/environment`, the
// `mode-watcher` package and the real API client; answering all three with
// stubs keeps `browser` true (so every storage path actually runs) and lets
// each test decide what `setMode` and `/admin/theme` do.
const ENV_STUB = "stub:app-environment";
const MODE_STUB = "stub:mode-watcher";
const ACCOUNT_STUB = "stub:api-account";

/** Both stubs expose a swappable `stub` object the store and the test share. */
const modeStubSource = `
export const stub = { setMode: () => {} };
export function setMode(value) {
  stub.setMode(value);
}
`;

const accountStubSource = `
export const stub = { getTheme: async () => ({ theme: "auto" }) };
export function getTheme() {
  return stub.getTheme();
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "$app/environment") return { url: ENV_STUB, shortCircuit: true };
    if (specifier === "mode-watcher") return { url: MODE_STUB, shortCircuit: true };
    if (specifier === "$lib/api/account") return { url: ACCOUNT_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === ENV_STUB) {
      return { format: "module", shortCircuit: true, source: "export const browser = true;" };
    }
    if (url === MODE_STUB) {
      return { format: "module", shortCircuit: true, source: modeStubSource };
    }
    if (url === ACCOUNT_STUB) {
      return { format: "module", shortCircuit: true, source: accountStubSource };
    }
    return nextLoad(url, context);
  },
});

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

  removeItem(key: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.values.delete(key);
  }
}

/** Stand-in for `document.documentElement`, recording what the store applied. */
class FakeElement {
  attributes = new Map<string, string>();
  classes = new Set<string>();
  classList = {
    toggle: (name: string, force: boolean): void => {
      if (force) this.classes.add(name);
      else this.classes.delete(name);
    },
  };

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

const storage = new FakeStorage();
const root = new FakeElement();
let prefersDark = false;

/** Install a browser global node does not provide; the store reads these at module scope. */
function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

defineGlobal("localStorage", storage);
defineGlobal("document", { documentElement: root });
defineGlobal("window", { matchMedia: () => ({ matches: prefersDark }) });

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const modeModule: string = MODE_STUB;
const { stub: modeStub } = (await import(modeModule)) as {
  stub: { setMode: (value: string) => void };
};

const accountModule: string = ACCOUNT_STUB;
const { stub: accountStub } = (await import(accountModule)) as {
  stub: { getTheme: () => Promise<{ theme: string }> };
};

const themeModule: string = "./theme.ts";
const { hydratePalette, setPalette, setTheme } = (await import(
  themeModule
)) as typeof import("./theme");

/**
 * Evaluate a *fresh* copy of the store: `readStored()` only runs at module
 * scope, so each of its cases needs its own module instance, which a distinct
 * query string buys.
 */
async function importFreshStore(tag: string): Promise<void> {
  const specifier: string = `./theme.ts?case=${tag}`;
  await import(specifier);
}

/** The values `setMode` was handed, newest last. */
function recordMode(): string[] {
  const calls: string[] = [];
  modeStub.setMode = (value) => {
    calls.push(value);
  };
  return calls;
}

/** Make `setMode` unavailable the way mode-watcher does before ModeWatcher mounts. */
function breakMode(): void {
  modeStub.setMode = () => {
    throw new Error("ModeWatcher is not mounted");
  };
}

beforeEach(() => {
  storage.values.clear();
  storage.failReads = false;
  storage.failWrites = false;
  root.attributes.clear();
  root.classes.clear();
  prefersDark = false;
  modeStub.setMode = () => {};
  accountStub.getTheme = async () => ({ theme: "auto" });
});

describe("readStored", () => {
  it("applies a valid stored choice on init", async () => {
    storage.values.set("codex.theme", "dark");
    const modes = recordMode();
    await importFreshStore("valid");
    assert.deepEqual(modes, ["dark"]);
  });

  it("ignores a stored value that is not a theme choice", async () => {
    storage.values.set("codex.theme", "chartreuse");
    const modes = recordMode();
    await importFreshStore("invalid");
    assert.deepEqual(modes, ["system"]);
  });

  it("defaults to system when nothing is stored", async () => {
    const modes = recordMode();
    await importFreshStore("absent");
    assert.deepEqual(modes, ["system"]);
  });

  it("defaults to system when storage access throws, so the bundle still boots", async () => {
    storage.failReads = true;
    const modes = recordMode();
    await importFreshStore("throws");
    assert.deepEqual(modes, ["system"]);
  });
});

describe("setTheme", () => {
  it("persists the choice and hands it to mode-watcher", () => {
    const modes = recordMode();
    setTheme("light");
    assert.equal(storage.values.get("codex.theme"), "light");
    assert.deepEqual(modes, ["light"]);
  });

  it("still applies the choice when persisting throws", () => {
    storage.failWrites = true;
    const modes = recordMode();
    setTheme("dark");
    assert.deepEqual(modes, ["dark"]);
  });

  it("toggles the dark class itself when setMode throws", () => {
    breakMode();
    setTheme("dark");
    assert.equal(root.classes.has("dark"), true);
    setTheme("light");
    assert.equal(root.classes.has("dark"), false);
  });

  it("resolves a system choice against the media query in that fallback", () => {
    breakMode();
    prefersDark = true;
    setTheme("system");
    assert.equal(root.classes.has("dark"), true);
    prefersDark = false;
    setTheme("system");
    assert.equal(root.classes.has("dark"), false);
  });
});

describe("setPalette", () => {
  it("persists the palette and marks it on the root element", () => {
    setPalette("bright-pink");
    assert.equal(storage.values.get("codex.theme.palette"), "bright-pink");
    assert.equal(root.attributes.get("data-theme"), "bright-pink");
  });

  it("clears both when the palette is null", () => {
    setPalette("dark-pink");
    setPalette(null);
    assert.equal(storage.values.has("codex.theme.palette"), false);
    assert.equal(root.attributes.has("data-theme"), false);
  });

  it("still marks the element when persisting throws", () => {
    storage.failWrites = true;
    setPalette("auto-pink");
    assert.equal(root.attributes.get("data-theme"), "auto-pink");
  });
});

describe("hydratePalette", () => {
  it("applies the stored palette and then the server's", async () => {
    storage.values.set("codex.theme.palette", "auto-pink");
    accountStub.getTheme = async () => ({ theme: "dark-pink" });
    await hydratePalette();
    assert.equal(root.attributes.get("data-theme"), "dark-pink");
    assert.equal(storage.values.get("codex.theme.palette"), "dark-pink");
  });

  it("clears the palette when the server holds a plain theme", async () => {
    storage.values.set("codex.theme.palette", "bright-pink");
    accountStub.getTheme = async () => ({ theme: "light" });
    await hydratePalette();
    assert.equal(root.attributes.has("data-theme"), false);
    assert.equal(storage.values.has("codex.theme.palette"), false);
  });

  it("ignores a stored value that is not a palette", async () => {
    storage.values.set("codex.theme.palette", "neon");
    accountStub.getTheme = async () => {
      throw new Error("offline");
    };
    await hydratePalette();
    assert.equal(root.attributes.has("data-theme"), false);
  });

  it("keeps the stored palette when the server fetch rejects", async () => {
    storage.values.set("codex.theme.palette", "auto-pink");
    accountStub.getTheme = async () => {
      throw new Error("offline");
    };
    await hydratePalette();
    assert.equal(root.attributes.get("data-theme"), "auto-pink");
  });

  it("falls through to the server when reading storage throws", async () => {
    storage.failReads = true;
    accountStub.getTheme = async () => ({ theme: "bright-pink" });
    await hydratePalette();
    assert.equal(root.attributes.get("data-theme"), "bright-pink");
  });
});
