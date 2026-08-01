import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

const ENV = "stub:theme-environment";
const MODE = "stub:theme-mode";
const ACCOUNT = "stub:theme-account";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "$app/environment") return { url: ENV, shortCircuit: true };
    if (specifier === "mode-watcher") return { url: MODE, shortCircuit: true };
    if (specifier === "$lib/api/account") return { url: ACCOUNT, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === ENV) return { format: "module", shortCircuit: true, source: "export const browser = true;" };
    if (url === MODE) return { format: "module", shortCircuit: true, source: "export const calls=[]; export function setMode(value){ calls.push(value); }" };
    if (url === ACCOUNT) return { format: "module", shortCircuit: true, source: "export const stub={response:{theme:'auto'}}; export async function getTheme(){return stub.response;}" };
    return nextLoad(url, context);
  },
});

class Storage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const storage = new Storage();
const classes = new Set<string>();
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "document", { value: { documentElement: { classList: { toggle: (name: string, active: boolean) => active ? classes.add(name) : classes.delete(name) } } }, configurable: true });
Object.defineProperty(globalThis, "window", { value: { matchMedia: () => ({ matches: false }) }, configurable: true });

const themeModule: string = "./theme.ts";
const { hydrateTheme, normalizeThemeChoice, setTheme } = (await import(themeModule)) as typeof import("./theme");
const modeModule: string = MODE;
const mode = (await import(modeModule)) as { calls: string[] };
const accountModule: string = ACCOUNT;
const { stub: account } = (await import(accountModule)) as { stub: { response: { theme: string } } };

beforeEach(() => { storage.values.clear(); classes.clear(); mode.calls.length = 0; account.response = { theme: "auto" }; });

describe("theme migration", () => {
  it("maps every historical pink preference into the single neutral theme family", () => {
    assert.equal(normalizeThemeChoice("auto-pink"), "system");
    assert.equal(normalizeThemeChoice("bright-pink"), "light");
    assert.equal(normalizeThemeChoice("dark-pink"), "dark");
    assert.equal(normalizeThemeChoice("auto"), "system");
    assert.equal(normalizeThemeChoice("nope"), null);
  });

  it("writes only light, dark, or system and removes the old palette key", () => {
    storage.values.set("codex.theme.palette", "dark-pink");
    setTheme("light");
    assert.equal(storage.values.get("codex.theme"), "light");
    assert.equal(storage.values.has("codex.theme.palette"), false);
    assert.equal(mode.calls.at(-1), "light");
  });

  it("normalizes a legacy server preference during hydration", async () => {
    account.response = { theme: "bright-pink" };
    await hydrateTheme();
    assert.equal(storage.values.get("codex.theme"), "light");
    assert.equal(storage.values.has("codex.theme.palette"), false);
  });
});
