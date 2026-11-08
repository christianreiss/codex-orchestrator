import { test } from "node:test";
import assert from "node:assert/strict";
const browserModule: string = "./browser.ts";
const { attachCopyButtons } = await import(browserModule) as typeof import("./browser");

test("code copy preserves exact text and waits for clipboard acceptance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  let click: () => Promise<void> = async () => {};
  let accept: () => void = () => {};
  let copied = "";
  const button = { textContent: "", disabled: false, setAttribute: () => {}, addEventListener: (_name: string, handler: () => Promise<void>) => { click = handler; } };
  const pre = { dataset: {}, querySelector: () => ({ textContent: "echo one\necho two\n" }), appendChild: () => {} };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => button } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: (text: string) => { copied = text; return new Promise<void>(resolve => { accept = resolve; }); } } } });
  try {
    attachCopyButtons({ querySelectorAll: () => [pre] } as unknown as HTMLElement);
    const pending = click();
    assert.equal(button.textContent, "Copy");
    assert.equal(button.disabled, true);
    assert.equal(copied, "echo one\necho two\n");
    accept(); await pending;
    assert.equal(button.textContent, "Copied");
    t.mock.timers.tick(1600);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new Error("Denied"); } } } });
    await click();
    assert.equal(button.textContent, "Copy failed");
    assert.equal(button.disabled, false);
    t.mock.timers.tick(1600);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    await click();
    assert.equal(button.textContent, "Copy failed");
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator); else Reflect.deleteProperty(globalThis, "navigator");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});
