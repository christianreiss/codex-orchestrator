package io.uggs.orchestrator

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MobileOverviewTest {
    private fun agent(json: String) = JSONObject(json)
    @Test fun shortSummariesKeepUnicodeAndNeverUseTheWholeAnswer() {
        assertEquals("DNS fixed. Restart needed.", compactSummary(" DNS fixed.\nRestart needed. "))
        assertEquals("😀".repeat(159) + "…", compactSummary("😀".repeat(161)))
        assertNull(compactSummary("  "))
        assertEquals("Build passed.", agentSummary(agent("""{"preview":{"summary":"Build passed."},"pending_prompt":{"question":"Full question"}}""")))
        assertEquals("Your reply is needed.", agentSummary(agent("""{"pending_prompt":{"question":"Full question"}}""")))
        assertNull(agentSummary(agent("""{"text":"Full answer"}""")))
    }
    @Test fun requiresRealReceiverReadinessRatherThanActiveStatus() {
        val rows = listOf(
            agent("""{"id":"ready","relay_ready":true,"presence":"listening"}"""),
            agent("""{"id":"working","relay_ready":true,"presence":"working"}"""),
            agent("""{"id":"idle","relay_ready":false,"status":"active","presence":"idle"}"""),
            agent("""{"id":"offline","relay_ready":true,"presence":"offline"}"""),
            agent("""{"id":"ended","relay_ready":true,"presence":"ended"}"""),
            agent("""{"id":"readonly","relay_ready":true,"read_only":true}"""),
            agent("""{"id":"missing","status":"active"}"""),
        )
        assertEquals(listOf("ready", "working"), readyAgents(rows).map { it.getString("id") })
    }
    @Test fun questionsAndAttentionComeBeforeRoutineConversations() {
        val rows = listOf(
            agent("""{"id":"ready","relay_ready":true}"""),
            agent("""{"id":"attention","relay_ready":true,"attention":{"summary":"Check build"}}"""),
            agent("""{"id":"question","relay_ready":true,"pending_prompt":{"question":"Deploy?"}}"""),
            agent("""{"id":"stale-question","relay_ready":false,"pending_prompt":{"question":"Old?"}}"""),
        )
        assertEquals(listOf("question", "attention", "ready"), readyAgents(rows).map { it.getString("id") })
    }
    @Test fun rejectsExpiredOrMalformedApprovalsEvenBeforeTheNextPoll() {
        val now = java.time.Instant.parse("2026-10-04T16:00:00Z").toEpochMilli()
        assertTrue(liveApproval(agent("""{"live":true,"expires_at":"2026-10-04T16:00:01Z"}"""), now))
        for (row in listOf("""{"live":true,"expires_at":"2026-10-04T16:00:00Z"}""", """{"live":false,"expires_at":"2026-10-04T16:00:01Z"}""", """{"live":true,"expires_at":"broken"}""")) assertFalse(liveApproval(agent(row), now))
    }
    @Test fun transcriptOmitsLifecycleNoiseWithoutLosingActualMessages() {
        val rows = listOf("user_message", "session_started", "assistant_message", "receiver_ready").map { agent("""{"type":"$it","payload":{"text":"content"}}""") }
        assertEquals(listOf("user_message", "assistant_message"), conversationEvents(rows).map { it.getString("type") })
    }
}
