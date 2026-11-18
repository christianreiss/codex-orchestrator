package io.uggs.orchestrator

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class QueueRulesTest {
    private fun agent(presence: String, relayReady: Boolean, extra: JSONObject.() -> Unit = {}) =
        JSONObject().put("id", "a").put("presence", presence).put("relay_ready", relayReady)
            .put("receiver", JSONObject().put("failure", JSONObject.NULL).put("sources", org.json.JSONArray().put(JSONObject().put("source", "portal")))).apply(extra)

    @Test fun connectedAgentsThatDoNotTakeMessagesAreQueueable() {
        assertTrue(isQueueable(agent("working", false)))
        assertTrue(isQueueable(agent("idle", false)))
        // Ready agents send directly; offline and ended agents are neither listed nor queueable.
        assertFalse(isQueueable(agent("listening", true)))
        assertFalse(isQueueable(agent("offline", false)))
        assertFalse(isQueueable(agent("ended", false)))
        assertFalse(isQueueable(agent("working", false) { put("read_only", true) }))
    }

    @Test fun failedReceiversAndRemoteDaemonSessionsDoNotQueue() {
        assertFalse(isQueueable(agent("working", false) { put("receiver", JSONObject().put("failure", "probe_failed")) }))
        assertTrue(isQueueable(agent("working", false) { put("receiver", JSONObject().put("failure", JSONObject.NULL)) }))
        assertFalse(isQueueable(agent("working", false) { put("daemon_session", true) }))
        // Without receiver state, or with the portal source closed, the server refuses: so does the app.
        assertFalse(isQueueable(agent("working", false) { remove("receiver") }))
        assertFalse(isQueueable(agent("working", false) { put("receiver", JSONObject().put("failure", JSONObject.NULL).put("sources", org.json.JSONArray().put(JSONObject().put("source", "peer")))) }))
    }

    @Test fun queueProtocolIsReadFromMe() {
        assertTrue(ToolsFlags.from(JSONObject().put("portal_queue_protocol", 1)).portalQueue)
        assertFalse(ToolsFlags.from(JSONObject()).portalQueue)
        assertFalse(ToolsFlags.NONE.portalQueue)
    }

    @Test fun rowRoleNamesAttentionFirstThenActivity() {
        val now = System.currentTimeMillis()
        assertEquals(StatusRole.Attention, agentRole(agent("listening", true), now, true, attention = true))
        assertEquals(StatusRole.Ready, agentRole(agent("listening", true), now, true, attention = false))
        assertEquals(StatusRole.Waiting, agentRole(agent("idle", false), now, true, attention = false))
        assertEquals(StatusRole.Working, agentRole(agent("working", false), now, true, attention = false))
        assertEquals(StatusRole.Offline, agentRole(agent("listening", true), now, false, attention = false))
    }
}
