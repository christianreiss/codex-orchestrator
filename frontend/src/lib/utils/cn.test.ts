import { test } from "node:test";
import assert from "node:assert/strict";
const modulePath: string = "./cn.ts";
const { cn } = await import(modulePath) as typeof import("./cn");

test("custom type sizes preserve semantic colors while replacing font sizes", () => {
  const value = cn("text-sm text-primary-foreground", "text-body-sm");
  assert.match(value, /text-primary-foreground/);
  assert.match(value, /text-body-sm/);
  assert.doesNotMatch(value, /(?:^| )text-sm(?: |$)/);
});
