package io.uggs.orchestrator

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class NativeActivityTest {
    private val now = Instant.parse("2026-10-11T12:00:00Z").toEpochMilli()
    private fun agent() = JSONObject().put("presence", "listening").put("relay_ready", true)
        .put("heartbeat_at", Instant.ofEpochMilli(now).toString())
        .put("activity", JSONObject().put("state", "working").put("source", "grok-session")
            .put("expires_at", Instant.ofEpochMilli(now + 45000).toString()))
    @Test fun activityIsIndependentOfDelivery() {
        val row = agent()
        assertEquals("Working", activityLabel(row, now))
        row.put("relay_ready", false)
        assertEquals("Working", activityLabel(row, now))
        assertFalse(isReachable(row))
        assertEquals("unknown", nativeActivity(row, now + 45000))
    }
    @Test fun lifecycleAndLegacyRemainSupported() {
        val row = agent().put("presence", "ended")
        assertEquals("Ended", activityLabel(row, now))
        row.put("presence", "listening").remove("activity")
        assertEquals("Listening", activityLabel(row, now))
    }
    @Test fun explicitQuestionsAndUnknownValues() {
        val row = agent()
        row.getJSONObject("activity").put("state", "future")
        assertEquals("Unknown", activityLabel(row, now))
        row.getJSONObject("activity").put("source", "portal-question").remove("expires_at")
        row.put("pending_prompt", JSONObject().put("id", "question"))
        assertEquals("Waiting for you", activityLabel(row, now))
    }
    @Test fun evidenceExpiryDoesNotInventASessionLifecycle() {
        val row = agent().put("receiver", JSONObject().put("failure", JSONObject.NULL)
            .put("heartbeat_at", Instant.ofEpochMilli(now).toString()))
        assertEquals("Working · Can receive messages", activityDetail(row, now))
        assertEquals("Unknown · Can receive messages", activityDetail(row, now + 45000))
        row.put("presence", "offline")
        assertEquals("Offline", activityDetail(row, now + 45000))
    }
}
