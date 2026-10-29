package io.uggs.orchestrator

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

/** Pins the behavior of the pieces extracted from CompanionModel. */
class CompanionSlicesTest {
    @Test fun liveFramesParseKnownTypesOnly() {
        assertEquals(LiveFrame.Hello, parseLiveFrame("""{"type":"hello"}"""))
        assertEquals(LiveFrame.Ping, parseLiveFrame("""{"type":"ping"}"""))
        assertEquals(LiveFrame.Changed(setOf("agents", "rooms")), parseLiveFrame("""{"type":"changed","scopes":["agents","rooms"]}"""))
        assertEquals(LiveFrame.Changed(emptySet()), parseLiveFrame("""{"type":"changed"}"""))
        assertNull(parseLiveFrame("""{"type":"other"}"""))
        assertNull(parseLiveFrame("not json"))
    }

    @Test fun reconnectBackoffDoublesToThirtySeconds() {
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16_000L, 30_000L, 30_000L), (0..6).map(::reconnectDelay))
    }

    @Test fun repeatedSendReusesTheUnconfirmedIntent() {
        val metadata = JSONObject().put("attachments", org.json.JSONArray())
        val first = chatSendIntent(emptyList(), "agent", null, "Hello", metadata)
        assertEquals("/agents/agent/messages", first.target)
        assertNull(first.version)
        assertSame(first, chatSendIntent(listOf(first), "agent", null, "Hello", metadata))
        assertNotEquals(first.uuid, chatSendIntent(listOf(first), "agent", null, "Changed", metadata).uuid)
        val prompt = JSONObject().put("id", "p1").put("version", 3)
        val answer = chatSendIntent(listOf(first), "agent", prompt, "Hello", metadata)
        assertNotEquals(first.uuid, answer.uuid)
        assertEquals("/agents/agent/prompts/p1/answer", answer.target)
        assertEquals(3, answer.version)
        assertSame(answer, chatSendIntent(listOf(first, answer), "agent", prompt, "Hello", metadata))
    }

    @Test fun directHistoryLoadsTailThenTheAdvertisedReply() = runBlocking {
        val server = MockWebServer()
        try {
            server.start()
            val client = Api(server.url("/").toString().trimEnd('/'), "test")
            server.enqueue(MockResponse().setBody("""{"events":[{"cursor":5,"type":"progress","payload":{}}],"next_cursor":5}"""))
            server.enqueue(MockResponse().setBody("""{"events":[{"cursor":3,"type":"assistant_message","payload":{"text":"Hi"}}],"next_cursor":5}"""))
            val loaded = loadDirectHistory(client, "agent", 3, emptyList(), 0, false)
            assertEquals(listOf(3L, 5L), loaded.events.map { it.getLong("cursor") })
            assertEquals(5L, loaded.cursor)
            assertTrue(server.takeRequest(2, TimeUnit.SECONDS)!!.path!!.endsWith("/agents/agent/events?tail=1"))
            assertTrue(server.takeRequest(2, TimeUnit.SECONDS)!!.path!!.endsWith("/agents/agent/events?after=2"))
        } finally { server.close() }
    }

    @Test fun directHistoryContinuesAfterLoadedCursor() = runBlocking {
        val server = MockWebServer()
        try {
            server.start()
            val client = Api(server.url("/").toString().trimEnd('/'), "test")
            server.enqueue(MockResponse().setBody("""{"events":[],"next_cursor":7}"""))
            val existing = listOf(JSONObject().put("cursor", 7).put("type", "user_message").put("payload", JSONObject().put("text", "Hello")))
            val loaded = loadDirectHistory(client, "agent", 0, existing, 7, true)
            assertEquals(existing, loaded.events)
            assertTrue(server.takeRequest(2, TimeUnit.SECONDS)!!.path!!.endsWith("/agents/agent/events?after=7"))
            assertEquals(1, server.requestCount)
        } finally { server.close() }
    }
}
