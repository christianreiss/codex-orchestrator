import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeedbackItem } from "../../api/feedback";

// See format.test.ts: node --test needs the ".ts" extension at runtime.
const modulePath: string = "./report-model.ts";
const { feedbackRow } = (await import(modulePath)) as typeof import("./report-model");

function report(changes: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: "fb-1", type: "bug", title: "Wrapper hangs", component: "wrapper", priority: "high", status: "open",
    version: 1, source: {}, deployment: "unknown", deployment_ref: null, duplicate_of: null, claim_owner: null,
    claim_expires_at: null, created_at: "2026-10-19T09:00:00.000Z", updated_at: "2026-10-19T11:00:00.000Z",
    ...changes,
  };
}

describe("feedbackRow", () => {
  it("ages a report from its creation time, not its last update", () => {
    assert.equal(feedbackRow(report()).created, "2026-10-19T09:00:00.000Z");
  });

  it("keeps meta as plain text so the relative time is rendered by the Timestamp component", () => {
    const row = feedbackRow(report());
    assert.equal(row.meta, "wrapper");
    assert.doesNotMatch(row.meta ?? "", /[<>$]/);
  });

  it("passes a missing or invalid creation time through for Timestamp to show as unknown", () => {
    assert.equal(feedbackRow(report({ created_at: "" })).created, "");
    assert.equal(feedbackRow(report({ created_at: "not-a-date" })).created, "not-a-date");
  });

  it("maps priority, type and status to badges and the claim owner to the note", () => {
    const row = feedbackRow(report({ priority: "critical", status: "resolved", claim_owner: { kind: "system" } }));
    assert.deepEqual(row.badges.map((b) => [b.label, b.variant]), [["critical", "destructive"], ["bug", undefined], ["resolved", "success"]]);
    assert.equal(row.note, "System");
  });
});
