package io.uggs.orchestrator

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class HostsTest {
    @Test fun choosesOnlyAnAvailableEngine() {
        assertEquals("codex", defaultHostEngine(JSONObject("""{"engines":["grok","codex"]}""")))
        assertEquals("claude", defaultHostEngine(JSONObject("""{"engines":["claude"]}""")))
        assertEquals("grok", defaultHostEngine(JSONObject("""{"engines":["grok"]}""")))
        assertNull(defaultHostEngine(JSONObject("""{"engines":[]}""")))
    }
    @Test fun explainsUnavailableHostsAndUnknownExecutions() {
        val host = JSONObject("""{"engines":["codex"],"free_slots":0,"health":{"reasons":["heartbeat_expired"]}}""")
        assertEquals("Host is offline", hostReason(TestTexts, host))
        host.getJSONObject("health").put("reasons", org.json.JSONArray())
        assertEquals("All slots are occupied", hostReason(TestTexts, host))
        assertTrue(remoteStatus(TestTexts, "unknown").contains("Outcome unknown"))
        assertTrue(remoteStatus(TestTexts, "queued").contains("queued"))
    }
}
