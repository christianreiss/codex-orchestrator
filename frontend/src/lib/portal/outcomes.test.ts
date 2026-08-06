import assert from "node:assert/strict";
import { describe, it } from "node:test";

const outcomesModule: string = "./outcomes.ts";
const {
  announcementFor,
  closeOutcome,
  closeReasonFor,
  describeFailure,
  sendFailureMessage,
  threadHash,
  threadIdFromHash,
} = (await import(outcomesModule)) as typeof import("./outcomes");

describe("closeOutcome", () => {
  // This distinction is the whole escalation path: without it a refused
  // cooperative close is just an error, and "Force end" stays unreachable
  // because it only ever rendered inside a closing bar that never appeared.
  it("treats an unreachable agent as escalatable rather than failed", () => {
    assert.equal(closeOutcome({ code: "agent_relay_unavailable" }), "unreachable");
    assert.equal(closeOutcome({ code: "agent_session_finished" }), "unreachable");
  });

  it("leaves every other failure alone", () => {
    assert.equal(closeOutcome({ code: "agent_portal_user_disabled" }), "failed");
    assert.equal(closeOutcome({}), "failed");
  });

  it("names the reason it reopened in force mode", () => {
    assert.match(closeReasonFor({ code: "agent_session_finished" }), /already ended/);
    assert.match(closeReasonFor({ code: "agent_relay_unavailable" }), /not reachable/);
  });
});

describe("sendFailureMessage", () => {
  it("says where the text went, for every recoverable case", () => {
    for (const code of ["agent_relay_unavailable", "agent_session_finished"]) {
      assert.match(sendFailureMessage({ code }), /back in the box/, code);
    }
  });

  it("explains a lost race on a prompt", () => {
    assert.match(sendFailureMessage({ code: "already_answered" }), /already answered/);
  });

  it("falls back to the server's own words when it had some", () => {
    assert.equal(sendFailureMessage({ message: "Message too large" }), "Message too large");
  });

  // "Failed to fetch" is the browser talking to itself, not a message for a
  // person, and an empty statusText used to render as a blank paragraph.
  it("never surfaces a raw transport string", () => {
    assert.match(sendFailureMessage({ message: "Failed to fetch" }, false), /Check your connection/);
    assert.match(describeFailure({ message: "" }, "Fallback."), /Fallback\./);
    assert.match(describeFailure({ message: "   " }, "Fallback."), /Fallback\./);
  });
});

describe("announcementFor", () => {
  it("tells a screen reader that something was thrown away", () => {
    assert.match(announcementFor("message_canceled", "Codex · crane"), /not delivered/);
  });

  it("separates a request for attention from ordinary output", () => {
    assert.match(announcementFor("attention", "Codex · crane"), /needs you/);
    assert.match(announcementFor("waiting_input", "Codex · crane"), /needs you/);
    assert.match(announcementFor("assistant_message", "Codex · crane"), /New message/);
  });
});

describe("thread deep links", () => {
  it("round-trips a session id", () => {
    const id = "6f1c2a44-0000-4000-8000-000000000001";
    assert.equal(threadIdFromHash(threadHash(id)), id);
  });

  it("survives an id needing encoding", () => {
    assert.equal(threadIdFromHash(threadHash("a/b c")), "a/b c");
  });

  it("ignores anything that is not a thread link", () => {
    // The magic-link fragment lands in the same place and must not be read as
    // a thread id.
    assert.equal(threadIdFromHash("#t=secret-token"), "");
    assert.equal(threadIdFromHash(""), "");
    assert.equal(threadIdFromHash("#/other/1"), "");
  });

  it("clears the hash for an empty selection", () => {
    assert.equal(threadHash(""), "");
  });
});
