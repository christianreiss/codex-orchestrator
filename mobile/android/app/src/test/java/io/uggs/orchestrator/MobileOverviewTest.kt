package io.uggs.orchestrator

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MobileOverviewTest {
    @Test fun accessWindowsFailClosedAtExpiryAndOnMalformedDeadlines() {
        val now = java.time.Instant.parse("2026-10-12T10:00:00Z").toEpochMilli()
        val window = JSONObject().put("enabled_until", "2026-10-12T10:00:01Z").put("open", true)
        assertTrue(liveWindow(window, now))
        assertTrue(liveFleetWindow(window, now))
        assertFalse(liveWindow(window, now + 1000))
        assertFalse(liveFleetWindow(window, now + 1000))
        assertFalse(liveFleetWindow(null, now))
        window.put("open", false)
        assertFalse(liveFleetWindow(window, now))
        for (deadline in listOf("invalid", "", JSONObject.NULL)) {
            window.put("enabled_until", deadline)
            assertFalse(liveWindow(window, now))
        }
    }
    private fun agent(json: String) = JSONObject(json)
    @Test fun allShowsOnlineActiveAgentsAcrossEnginesWithoutRequiringAnOpenRelay() {
        for (engine in listOf("codex", "claude", "grok")) {
            for (presence in listOf("listening", "working", "idle", "offline", "ended", "unknown", "")) {
                val row = agent("""{"engine":"$engine","presence":"$presence","relay_ready":false,"status":"active"}""")
                assertEquals(presence, presence in listOf("listening", "working", "idle"), isOnlineActiveAgent(row))
                assertEquals(listOf(row), retainedChats(listOf(row)))
            }
        }
        assertFalse(isOnlineActiveAgent(agent("""{"presence":"listening","read_only":true}""")))
        for (status in listOf("closed", "failed", "unknown")) {
            assertFalse(isOnlineActiveAgent(agent("""{"presence":"working","daemon_session":true,"remote_status":"$status"}""")))
        }
        assertTrue(isOnlineActiveAgent(agent("""{"presence":"working","daemon_session":true,"remote_status":"queued","relay_ready":false}""")))
    }
    @Test fun retainedChatsSurvivePresenceChangesUntilTheServerRemovesThem() {
        val chat = agent("""{"id":"chat","presence":"listening","relay_ready":true}""")
        for (state in listOf("listening", "working", "idle", "offline", "ended", "listening")) {
            chat.put("presence", state).put("relay_ready", state == "listening")
            assertEquals(listOf(chat), retainedChats(listOf(chat)))
            assertEquals(state == "listening", isReachable(chat))
        }
        assertTrue(retainedChats(emptyList()).isEmpty())
    }
    @Test fun retainedDaemonHistoryRemainsReadableWithoutAllowingSends() {
        val rows = listOf("queued", "running", "stopping", "idle", "waiting", "closed", "failed", "unknown").map { status ->
            agent("""{"id":"$status","daemon_session":true,"remote_status":"$status","relay_ready":false}""")
        }
        assertEquals(rows, retainedChats(rows))
        assertTrue(readyAgents(rows).isEmpty())
        val recent = agent("""{"id":"recent","last_event_at":"2026-10-11T12:00:00Z"}""")
        assertEquals(recent, retainedChats(rows + recent).first())
    }
    @Test fun launchNamesIdentifyChatsWithAndWithoutTaskTitles() {
        val named = agent("""{"id":"11111111-aaaa","launch_name":"Claudia","session_name":"Release review","task_title":"Release review"}""")
        assertEquals("(Claudia) Release review", agentTitle(TestTexts, named))
        named.put("session_name", "(Claudia) Release review")
        assertEquals("(Claudia) Release review", agentTitle(TestTexts, named))
        named.put("task_title", JSONObject.NULL)
        assertEquals("(Claudia) Release review", agentTitle(TestTexts, named))
        named.put("session_name", JSONObject.NULL)
        assertEquals("(Claudia)", agentTitle(TestTexts, named))
        named.put("launch_name", " Bärbel ")
        named.put("task_title", " Schema\nprepared ")
        assertEquals("(Bärbel) Schema prepared", agentTitle(TestTexts, named))
        named.put("launch_name", JSONObject.NULL)
        assertEquals("Session 11111111", agentTitle(TestTexts, named))
        named.put("launch_name", " ")
        assertEquals("Session 11111111", agentTitle(TestTexts, named))
        assertEquals("(Paula) Checks passed", agentTitle(TestTexts, agent("""{"session_name":"(Paula) Checks passed"}""")))
    }
    @Test fun namesDistinguishSessionsInTheSameProjectAndUnnamedSessionsHaveAnIdentity() {
        val first = agent("""{"id":"11111111-aaaa","session_name":" Release\nreview ","cwd":"/work/shared","host":"lab.example"}""")
        val second = agent("""{"id":"22222222-bbbb","session_name":"Database migration","cwd":"/work/shared","host":"lab.example"}""")
        assertEquals("Release review", agentTitle(TestTexts, first))
        assertEquals("Database migration", agentTitle(TestTexts, second))
        first.put("session_name", JSONObject.NULL)
        assertEquals("Session 11111111", agentTitle(TestTexts, first))
        first.put("upstream_session_id", "33333333-cccc")
        assertEquals("Session 33333333", agentTitle(TestTexts, first))
        first.put("upstream_session_id", JSONObject.NULL)
        assertEquals("Session 11111111", agentTitle(TestTexts, first))
        first.put("id", JSONObject.NULL)
        assertEquals("Unnamed session", agentTitle(TestTexts, first))
        assertEquals("Unnamed session", agentTitle(TestTexts, JSONObject()))
    }
    @Test fun shortSummariesKeepUnicodeAndNeverUseTheWholeAnswer() {
        assertEquals("DNS fixed. Restart needed.", compactSummary(" DNS fixed.\nRestart needed. "))
        assertEquals("😀".repeat(159) + "…", compactSummary("😀".repeat(161)))
        assertNull(compactSummary("  "))
        assertEquals("Build passed.", agentSummary(TestTexts, agent("""{"preview":{"summary":"Build passed."},"pending_prompt":{"question":"Full question"}}""")))
        assertEquals("Your reply is needed.", agentSummary(TestTexts, agent("""{"pending_prompt":{"question":"Full question"}}""")))
        assertNull(agentSummary(TestTexts, agent("""{"text":"Full answer"}""")))
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
