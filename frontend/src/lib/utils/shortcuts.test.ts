import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ShortcutMap } from "./shortcuts";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const shortcutsModule: string = "./shortcuts.ts";
const { bindGlobalShortcuts } = (await import(shortcutsModule)) as typeof import("./shortcuts");

type Listener = (event: unknown) => void;

/** Stand-in for the DOM node the handler inspects; only the fields it reads exist. */
class FakeElement {
  tagName: string;
  isContentEditable: boolean;

  constructor(tagName: string, isContentEditable = false) {
    this.tagName = tagName;
    this.isContentEditable = isContentEditable;
  }

  get label(): string {
    return this.isContentEditable ? `${this.tagName}[contenteditable]` : this.tagName;
  }
}

interface KeydownInit {
  target?: FakeElement | null;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
}

/** Stand-in for the browser KeyboardEvent; counts how often it was suppressed. */
class FakeKeydown {
  key: string;
  target: FakeElement | null;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  prevented = 0;

  constructor(key: string, init: KeydownInit = {}) {
    this.key = key;
    this.target = init.target ?? null;
    this.metaKey = init.metaKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.altKey = init.altKey ?? false;
    this.defaultPrevented = init.defaultPrevented ?? false;
  }

  preventDefault(): void {
    this.prevented += 1;
  }
}

const ALL_KEYS = ["?", "/", "n", "Escape"] as const;
const TYPING_KEYS = ["?", "/", "n"] as const;
type Modifier = "metaKey" | "ctrlKey" | "altKey";
const MODIFIERS: Modifier[] = ["metaKey", "ctrlKey", "altKey"];

/** Every focus the handler must read as "the user is typing". */
const TYPING_TARGETS = [
  new FakeElement("INPUT"),
  new FakeElement("TEXTAREA"),
  new FakeElement("SELECT"),
  new FakeElement("DIV", true),
];

/** Focus that leaves the shortcuts live: no element at all, or a plain one. */
const IDLE_TARGETS: (FakeElement | null)[] = [null, new FakeElement("DIV")];

function describeTarget(target: FakeElement | null): string {
  return target ? target.label : "no target";
}

const g = globalThis as unknown as Record<string, unknown>;
const real = { window: g.window, HTMLElement: g.HTMLElement };

let listeners: Listener[] = [];

/** A map wired to every key, recording which handler ran. */
function recordingMap(): { map: ShortcutMap; fired: string[] } {
  const fired: string[] = [];
  const map: ShortcutMap = {};
  for (const key of ALL_KEYS) map[key] = () => fired.push(key);
  return { map, fired };
}

function dispatch(event: FakeKeydown): void {
  for (const fn of [...listeners]) fn(event);
}

/** Send one keydown through a freshly bound, fully populated map. */
function press(event: FakeKeydown): string[] {
  const { map, fired } = recordingMap();
  const dispose = bindGlobalShortcuts(map);
  dispatch(event);
  dispose();
  return fired;
}

beforeEach(() => {
  listeners = [];
  g.HTMLElement = FakeElement;
  g.window = {
    addEventListener: (type: string, fn: Listener) => {
      if (type === "keydown") listeners.push(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      if (type === "keydown") listeners = listeners.filter((each) => each !== fn);
    },
  };
});

afterEach(() => {
  if (real.window === undefined) delete g.window;
  else g.window = real.window;
  if (real.HTMLElement === undefined) delete g.HTMLElement;
  else g.HTMLElement = real.HTMLElement;
});

describe("bindGlobalShortcuts", () => {
  it("runs '?', '/' and 'n' and suppresses the browser default when nothing is being typed in", () => {
    for (const key of TYPING_KEYS) {
      for (const target of IDLE_TARGETS) {
        const event = new FakeKeydown(key, { target });
        const where = `${key} at ${describeTarget(target)}`;

        assert.deepEqual(press(event), [key], where);
        assert.equal(event.prevented, 1, where);
      }
    }
  });

  it("leaves '?', '/' and 'n' to the field the user is typing in", () => {
    for (const key of TYPING_KEYS) {
      for (const target of TYPING_TARGETS) {
        const event = new FakeKeydown(key, { target });
        const where = `${key} at ${target.label}`;

        assert.deepEqual(press(event), [], where);
        assert.equal(event.prevented, 0, where);
      }
    }
  });

  it("runs Escape whatever has focus, without suppressing the default", () => {
    for (const target of [...IDLE_TARGETS, ...TYPING_TARGETS]) {
      const event = new FakeKeydown("Escape", { target });
      const where = `Escape at ${describeTarget(target)}`;

      assert.deepEqual(press(event), ["Escape"], where);
      assert.equal(event.prevented, 0, where);
    }
  });

  it("ignores every key while a modifier is held", () => {
    for (const key of ALL_KEYS) {
      for (const modifier of MODIFIERS) {
        const event = new FakeKeydown(key, { [modifier]: true });
        const where = `${key} with ${modifier}`;

        assert.deepEqual(press(event), [], where);
        assert.equal(event.prevented, 0, where);
      }
    }
  });

  it("ignores every key once something else has claimed the event", () => {
    for (const key of ALL_KEYS) {
      const event = new FakeKeydown(key, { defaultPrevented: true });

      assert.deepEqual(press(event), [], key);
      assert.equal(event.prevented, 0, key);
    }
  });

  it("is a no-op for a key the map does not declare", () => {
    const fired: string[] = [];
    const dispose = bindGlobalShortcuts({ "?": () => fired.push("?") });

    for (const key of ["/", "n", "Escape", "a"]) {
      const event = new FakeKeydown(key);
      dispatch(event);

      assert.deepEqual(fired, [], key);
      assert.equal(event.prevented, 0, key);
    }

    dispose();
  });

  it("stops listening once the disposer runs", () => {
    const { map, fired } = recordingMap();
    const dispose = bindGlobalShortcuts(map);

    dispose();
    assert.equal(listeners.length, 0);

    for (const key of ALL_KEYS) {
      const event = new FakeKeydown(key);
      dispatch(event);

      assert.deepEqual(fired, [], key);
      assert.equal(event.prevented, 0, key);
    }
  });
});
