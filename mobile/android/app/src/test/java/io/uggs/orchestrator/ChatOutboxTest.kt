package io.uggs.orchestrator

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.TimeUnit

class ChatOutboxTest {
    private val owner = ChatHistoryCache.owner(Connection("https://fleet.example", "private-token", "phone", null))
    private val metadata = JSONObject().put("attachments", JSONArray().put("4b0c3a8e-5d2f-4c1e-9a7b-1f2e3d4c5b6a")).put("reply_to", 7)
    private fun intent(text: String = "Hello", session: String = "agent") = chatSendIntent(emptyList(), session, null, text, metadata)
    private fun outboxSend(id: String, conversation: String = "agent", failed: Boolean = false, text: String = "x") =
        OutboxEntry(id, conversation, "/agents/$conversation/messages", JSONObject().put("client_message_id", id).put("content", text).toString(), "2026-10-29T10:00:00Z", failed)

    @Test fun aPersistedDirectSendRestoresWithTheSameIdAndBody() {
        val send = intent()
        val outbox = ChatOutbox(owner).apply { enqueue(send.outboxEntry("2026-10-29T10:00:00Z")) }
        val restored = ChatOutbox(owner, outbox.json())
        val entry = restored.entries.single()
        assertEquals(outbox.entries.single().body, entry.body)
        assertEquals(send.uuid, entry.id)
        assertEquals(send.uuid, JSONObject(entry.body).getString("client_message_id"))
        assertEquals(send, chatSendFromOutbox(entry))
        assertFalse(outbox.json()!!.contains("private-token"))
        val answer = chatSendIntent(emptyList(), "agent", JSONObject().put("id", "p1").put("version", 2), "Yes", metadata)
        assertEquals(answer, chatSendFromOutbox(answer.outboxEntry("now")))
        assertEquals(2, JSONObject(answer.outboxEntry("now").body).getInt("version"))
        assertNull(chatSendFromOutbox(entry.copy(conversation = "room:r")))
    }

    @Test fun processKilledAfterTheServerAcceptedResendsTheSameIdAndPayload() = runBlocking {
        val server = MockWebServer()
        try {
            // The server stores the message, then the connection dies before the ACK.
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(MockResponse().setResponseCode(202).setBody("""{"message_id":"m1","status":"queued"}"""))
            server.start()
            val client = Api(server.url("/").toString().trimEnd('/'), "test")
            val outbox = ChatOutbox(owner)
            var saved: String? = null
            outbox.onChange = { saved = outbox.json() }
            val send = intent()
            outbox.enqueue(send.outboxEntry("2026-10-29T10:00:00Z"))
            assertNotNull("persisted before the request", saved)
            val first = deliverOutboxEntry(client, outbox.entries.single())
            assertTrue(first is OutboxResult.Rejected && first.failure == SendFailure.Transient)
            outbox.update(send.uuid) { it.afterFailure(first as OutboxResult.Rejected, 1_000) }

            // Restart: only the encrypted blob survives.
            val restarted = ChatOutbox(owner, saved)
            val entry = restarted.entries.single()
            assertEquals(0L, entry.nextAttemptAt)
            assertEquals(1, entry.attempts)
            val second = deliverOutboxEntry(client, entry)
            assertEquals("m1", (second as OutboxResult.Accepted).response.getString("message_id"))
            restarted.remove(entry.id)
            assertNull(restarted.json())

            val bodies = (1..2).map { server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8() }
            assertEquals(bodies[0], bodies[1])
            assertEquals(send.uuid, JSONObject(bodies[1]).getString("client_message_id"))
            assertEquals("Hello", JSONObject(bodies[1]).getString("content"))
            assertEquals(7, JSONObject(bodies[1]).getJSONObject("metadata").getInt("reply_to"))
        } finally { server.close() }
    }

    @Test fun definitiveRejectionsStopWhileTransientOnesBackOff() = runBlocking {
        for (status in listOf(400, 403, 404, 409, 413, 422)) assertEquals("$status", SendFailure.Definitive, classifySendFailure(ApiException(status, "no")))
        for (status in listOf(408, 429, 500, 502, 503)) assertEquals("$status", SendFailure.Transient, classifySendFailure(ApiException(status, "later")))
        assertEquals(SendFailure.Transient, classifySendFailure(IOException("offline")))
        assertEquals(SendFailure.Transient, classifySendFailure(IllegalStateException("no ack")))
        assertEquals(listOf(30_000L, 60_000L, 120_000L, 240_000L, 300_000L, 300_000L), (1..6).map(::outboxRetryDelay))

        val base = outboxSend("a")
        val transient = base.afterFailure(OutboxResult.Rejected(ApiException(503, "busy"), SendFailure.Transient), 5_000)
        assertFalse(transient.failed)
        assertEquals(1, transient.attempts)
        assertEquals(35_000L, transient.nextAttemptAt)
        val definitive = transient.afterFailure(OutboxResult.Rejected(ApiException(409, "Retry payload differs"), SendFailure.Definitive), 9_000)
        assertTrue(definitive.failed)
        assertEquals("Retry payload differs", definitive.error)

        val server = MockWebServer()
        try {
            server.enqueue(MockResponse().setResponseCode(409).setBody("""{"message":"closed"}"""))
            server.enqueue(MockResponse().setResponseCode(429).setBody("""{"message":"slow down"}"""))
            server.start()
            val client = Api(server.url("/").toString().trimEnd('/'), "test")
            assertEquals(SendFailure.Definitive, (deliverOutboxEntry(client, base) as OutboxResult.Rejected).failure)
            assertEquals(SendFailure.Transient, (deliverOutboxEntry(client, base) as OutboxResult.Rejected).failure)
        } finally { server.close() }
    }

    @Test fun draftsRestorePerConversationAndEmptyDraftsDisappear() {
        val outbox = ChatOutbox(owner)
        outbox.setDraft("agent", "Half written", "12")
        outbox.setDraft("room:r1", "Room text", "6f0e1c2b-0000-4000-8000-000000000001")
        outbox.setDraft("agent-2", "Other", null)
        val restored = ChatOutbox(owner, outbox.json())
        assertEquals(ChatDraft("Half written", "12"), restored.draft("agent"))
        assertEquals(ChatDraft("Room text", "6f0e1c2b-0000-4000-8000-000000000001"), restored.draft("room:r1"))
        assertEquals(listOf("agent", "room:r1", "agent-2"), restored.drafts.keys.toList())
        restored.setDraft("agent", "", null)
        assertNull(restored.draft("agent"))
        assertNull(restored.draft(null))
        // Live state typed before the restore finished wins over the saved copy.
        val live = ChatOutbox(owner).apply { setDraft("agent", "Typed now", null); enqueue(outboxSend("live")) }
        live.restore(owner, ChatOutbox(owner).apply { setDraft("agent", "Old", null); enqueue(outboxSend("saved")) }.json())
        assertEquals("Typed now", live.draft("agent")!!.text)
        assertEquals(listOf("saved", "live"), live.entries.map { it.id })
    }

    @Test fun unreadableForeignAndOldDataRestoreAsEmpty() {
        val good = ChatOutbox(owner).apply { enqueue(outboxSend("a")); setDraft("agent", "draft", null) }.json()!!
        assertEquals(1, ChatOutbox(owner, good).entries.size)
        for (bad in listOf("not json", "{}", good.replace("\"version\":1", "\"version\":2"), JSONObject(good).put("owner", "other").toString(), null)) {
            val outbox = ChatOutbox(owner, bad)
            assertTrue(bad.toString(), outbox.isEmpty)
        }
        assertTrue(ChatOutbox("", good).isEmpty)
        // A damaged entry is skipped, the rest survives.
        val damaged = JSONObject(good).apply { getJSONArray("entries").put(JSONObject().put("id", "x").put("body", "{broken")) }.toString()
        assertEquals(listOf("a"), ChatOutbox(owner, damaged).entries.map { it.id })
        assertTrue(ChatOutbox(owner, "x".repeat(ChatOutbox.MAX_BYTES + 1)).isEmpty)
        // Decryptable but malformed shapes never crash the restore.
        val odd = JSONObject(good).apply { getJSONArray("entries").put(5).put("text"); put("draft_order", org.json.JSONArray().put(3).put("agent")) }.toString()
        val tolerant = ChatOutbox(owner, odd)
        assertEquals(listOf("a"), tolerant.entries.map { it.id })
        assertEquals("draft", tolerant.draft("agent")!!.text)
        assertTrue(ChatOutbox(owner, JSONObject(good).put("drafts", "broken").put("entries", 7).toString()).isEmpty)
    }

    @Test fun sizeBudgetDropsOldDraftsThenFailedThenOldestSends() {
        val outbox = ChatOutbox(owner)
        repeat(ChatOutbox.MAX_ENTRIES) { outbox.enqueue(outboxSend("e$it", failed = it == 10)) }
        outbox.enqueue(outboxSend("newest"))
        assertEquals(ChatOutbox.MAX_ENTRIES, outbox.entries.size)
        assertNull("failed sends go first", outbox.entry("e10"))
        outbox.enqueue(outboxSend("newer"))
        assertNull("then the oldest", outbox.entry("e0"))

        val big = "x".repeat(300 * 1024)
        val bytes = ChatOutbox(owner)
        bytes.setDraft("old-draft", big, null)
        bytes.enqueue(outboxSend("failed", failed = true, text = big))
        bytes.enqueue(outboxSend("pending", text = big))
        bytes.setDraft("new-draft", big, null)
        assertNull(bytes.draft("old-draft"))
        assertNotNull(bytes.draft("new-draft"))
        assertEquals(listOf("failed", "pending"), bytes.entries.map { it.id })
        bytes.enqueue(outboxSend("another", text = big))
        assertTrue(bytes.drafts.isEmpty())
        assertEquals(listOf("failed", "pending", "another"), bytes.entries.map { it.id })
        bytes.enqueue(outboxSend("last", text = big))
        assertEquals(listOf("pending", "another", "last"), bytes.entries.map { it.id })
        assertTrue(bytes.json()!!.toByteArray().size <= ChatOutbox.MAX_BYTES)
        repeat(ChatOutbox.MAX_DRAFTS + 5) { bytes.setDraft("d$it", "t", null) }
        assertEquals(ChatOutbox.MAX_DRAFTS, bytes.drafts.size)
        assertNull(bytes.draft("d0"))
    }

    @Test fun signOutAndCapabilityLossWipeAndFenceRestores() {
        val outbox = ChatOutbox(owner).apply {
            enqueue(outboxSend("direct")); enqueue(outboxSend("room", conversation = "room:r1"))
            setDraft("agent", "direct draft", null); setDraft("room:r1", "room draft", null)
        }
        var saved: String? = "unchanged"
        outbox.onChange = { saved = outbox.json() }
        val wipes = outbox.wipes
        outbox.clearWhere(drafts = false) { !it.startsWith("room:") }
        assertEquals(listOf("room"), outbox.entries.map { it.id })
        assertNotNull(outbox.draft("agent"))
        outbox.clearWhere { it.startsWith("room:") }
        assertTrue(outbox.entries.isEmpty())
        assertNull(outbox.draft("room:r1"))
        outbox.clear()
        assertTrue(outbox.isEmpty)
        assertNull("an empty outbox deletes its file", saved)
        assertTrue(outbox.wipes > wipes)
        outbox.reset("other-owner")
        assertEquals("other-owner", outbox.owner)
    }
}
