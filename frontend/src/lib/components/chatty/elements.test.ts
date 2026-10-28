import assert from "node:assert/strict";
import { describe, it } from "node:test";
const elementsModule: string = "./elements.ts";
const { chattyPath, isPlainClick, latestAnswerId } = (await import(elementsModule)) as typeof import("./elements");

describe("Chatty reply elements", () => {
  it("accepts only base-relative console paths", () => {
    for (const path of ["/hosts/7", "/projects/apollo/board", "/settings#chatty", "/library?type=memories", "/manual/hosts", "/library/skills/fleet%20ops"])
      assert.equal(chattyPath(path), path);
    for (const path of [
      "https://evil.example",
      "//evil.example/x",
      "javascript:alert(1)",
      "data:text/html,x",
      "/hosts/../login",
      "/hosts//7",
      "/admin/hosts/7",
      "/admin",
      "/hosts/7?next=https://evil.example",
      "/hosts/7#<b>",
      "hosts/7",
      "\\\\evil.example",
      "/\\evil.example",
      42,
      null,
    ])
      assert.equal(chattyPath(path), null, String(path));
  });

  it("keeps suggestions on the latest answer only", () => {
    assert.equal(latestAnswerId([{ id: 1, kind: "user" }, { id: 2, kind: "status" }, { id: 3, kind: "answer" }]), 3);
    assert.equal(latestAnswerId([{ id: 3, kind: "answer" }, { id: 4, kind: "user" }]), null);
    assert.equal(latestAnswerId([{ id: 3, kind: "answer" }, { id: 4, kind: "status" }]), 3);
    assert.equal(latestAnswerId([]), null);
  });

  it("leaves modified clicks to the browser", () => {
    const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    assert.equal(isPlainClick(base), true);
    assert.equal(isPlainClick({ ...base, ctrlKey: true }), false);
    assert.equal(isPlainClick({ ...base, button: 1 }), false);
  });
});
