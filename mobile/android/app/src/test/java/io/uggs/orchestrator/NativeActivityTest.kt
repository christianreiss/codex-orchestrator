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
    @Test fun chatIndicatorsSeparateWorkFromReceiverReadiness() {
        val row = agent().put("relay_ready", false)
        assertEquals(ChatAgentStatus.WORKING, chatAgentStatus(row, now, true))
        for (state in listOf("idle", "waiting")) {
            row.getJSONObject("activity").put("state", state)
            assertEquals(ChatAgentStatus.ONLINE, chatAgentStatus(row, now, true))
        }
        row.remove("activity")
        for (presence in listOf("listening", "idle")) {
            row.put("presence", presence)
            assertEquals(ChatAgentStatus.ONLINE, chatAgentStatus(row, now, true))
        }
        row.put("presence", "working")
        assertEquals(ChatAgentStatus.WORKING, chatAgentStatus(row, now, true))
    }
    @Test fun chatIndicatorsDoNotAdvertiseStaleOrClosedAgentsAsWorking() {
        val row = agent()
        assertEquals(ChatAgentStatus.UNKNOWN, chatAgentStatus(row, now, false))
        assertEquals(ChatAgentStatus.UNKNOWN, chatAgentStatus(row, now + 45000, true))
        for (presence in listOf("offline", "ended")) {
            row.put("presence", presence)
            assertEquals(ChatAgentStatus.OFFLINE, chatAgentStatus(row, now, true))
        }
        row.put("presence", "working").put("daemon_session", true).put("remote_status", "closed")
        assertEquals(ChatAgentStatus.OFFLINE, chatAgentStatus(row, now, true))
        row.remove("daemon_session")
        row.put("read_only", true)
        assertEquals(ChatAgentStatus.UNKNOWN, chatAgentStatus(row, now, true))
    }
    @Test fun receiverFailureInvalidatesNativeWorkEvidence() {
        val row = agent().put("receiver", JSONObject().put("failure", "disconnected")
            .put("heartbeat_at", Instant.ofEpochMilli(now).toString()))
        assertEquals(ChatAgentStatus.UNKNOWN, chatAgentStatus(row, now, true))
    }
    @Test fun activityIsIndependentOfDelivery() {
        val row = agent()
        assertEquals("Working", activityLabel(TestTexts, row, now))
        row.put("relay_ready", false)
        assertEquals("Working", activityLabel(TestTexts, row, now))
        assertFalse(isReachable(row))
        assertEquals("unknown", nativeActivity(row, now + 45000))
    }
    @Test fun lifecycleAndLegacyRemainSupported() {
        val row = agent().put("presence", "ended")
        assertEquals("Ended", activityLabel(TestTexts, row, now))
        row.put("presence", "listening").remove("activity")
        assertEquals("Listening", activityLabel(TestTexts, row, now))
    }
    @Test fun explicitQuestionsAndUnknownValues() {
        val row = agent()
        row.getJSONObject("activity").put("state", "future")
        assertEquals("Unknown", activityLabel(TestTexts, row, now))
        row.getJSONObject("activity").put("source", "portal-question").remove("expires_at")
        row.put("pending_prompt", JSONObject().put("id", "question"))
        assertEquals("Waiting for you", activityLabel(TestTexts, row, now))
    }
    @Test fun evidenceExpiryDoesNotInventASessionLifecycle() {
        val row = agent().put("receiver", JSONObject().put("failure", JSONObject.NULL)
            .put("heartbeat_at", Instant.ofEpochMilli(now).toString()))
        assertEquals("Working · Can receive messages", activityDetail(TestTexts, row, now))
        assertEquals("Unknown · Can receive messages", activityDetail(TestTexts, row, now + 45000))
        row.put("presence", "offline")
        assertEquals("Offline", activityDetail(TestTexts, row, now + 45000))
    }
}
