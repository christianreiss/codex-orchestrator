package io.uggs.orchestrator

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList

/** Room sends through the persisted outbox, and the offline room cache, against a fake server. */
class RoomOutboxTest {
    private val owner = ChatHistoryCache.owner(Connection("https://fleet.example", "private-token", "phone", null))
    private val roomId = "6f0e1c2b-0000-4000-8000-0000000000aa"
    private val server = MockWebServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val sends = CopyOnWriteArrayList<String>()
    private val sendResponses = ConcurrentLinkedQueue<MockResponse>()
    private var clock = 1_000L
    private var savedRooms: String? = null

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path!!.substringBefore('?')) {
                "/companion/v1/rooms" -> MockResponse().setBody("""{"rooms":[{"id":"$roomId","status":"open","title":"Release"}],"has_more":false,"next_offset":null}""")
                "/companion/v1/rooms/read" -> MockResponse().setBody("""{"room":{"id":"$roomId","status":"open","members":[]},"events":[{"id":"server-1","kind":"chat","content":"Earlier","actor":"agent:a","created_at":"2026-10-29T09:00:00Z"}],"next_before":null}""")
                "/companion/v1/rooms/send" -> { val body = request.body.readUtf8(); sends.add(body); sendResponses.poll() ?: accepted(body) }
                else -> MockResponse().setResponseCode(404).setBody("{}")
            }
        }
        server.start()
    }
    @After fun stop() { scope.cancel(); server.close() }

    private fun accepted(body: String) = MockResponse().setBody(JSONObject().put("id", "stored-" + JSONObject(body).getString("client_request_id"))
        .put("kind", "chat").put("actor", "admin:1").put("content", JSONObject(body).getString("content")).put("created_at", "2026-10-29T10:00:00Z").toString())
    private fun rooms(outbox: ChatOutbox, persisted: (() -> Unit)? = null) = RoomChats(scope, { Api(server.url("/").toString().trimEnd('/'), "test") }, { true },
        outbox, { savedRooms = if (it.isEmpty) null else it.json() }, { persisted?.invoke() }, { clock }, owner)
    private suspend fun until(message: String, condition: () -> Boolean) {
        withTimeout(5_000) { while (!condition()) delay(20) }
        assertTrue(message, condition())
    }
    private suspend fun openRoom(state: RoomChats) {
        state.open(JSONObject().put("id", roomId).put("status", "open"))
        until("room read") { state.events.isNotEmpty() && !state.loading }
    }

    @Test fun aSendIsPersistedFirstAndRetriesTheSameRequestAfterATransientFailure() = runBlocking {
        val outbox = ChatOutbox(owner)
        var saved: String? = null
        outbox.onChange = { saved = outbox.json() }
        var persistedAtSend: Boolean? = null
        val state = rooms(outbox) { persistedAtSend = saved?.contains("Ship it") == true }
        openRoom(state)
        state.draft = "Ship it"
        state.replyTo = "server-1"
        sendResponses.add(MockResponse().setResponseCode(503).setBody("""{"message":"Response lost"}"""))
        val sent = CopyOnWriteArrayList<String>()
        state.send(emptyList()) { id, _ -> sent.add(id) }
        assertEquals("draft and reply move into the bubble", "", state.draft)
        assertNull(state.replyTo)
        until("first attempt") { !state.busy && sends.size == 1 }
        assertEquals(true, persistedAtSend)
        val entry = state.pendingSend!!
        assertEquals(1, entry.attempts)
        assertEquals(1_000L + OUTBOX_FIRST_RETRY_MS, entry.nextAttemptAt)
        assertEquals("unconfirmed", state.localEvents.single().getString("delivery_status"))
        assertEquals("Response lost", state.error)
        assertEquals("server-1", JSONObject(sends[0]).getString("reply_to"))

        // Not yet due: the pump waits for the backoff step.
        assertEquals(1_000L + OUTBOX_FIRST_RETRY_MS, state.pump { _, _ -> })
        delay(100); assertEquals(1, sends.size)
        clock += OUTBOX_FIRST_RETRY_MS
        assertNull(state.pump { id, _ -> sent.add(id) })
        until("retry accepted") { state.pendingSend == null && sends.size == 2 }
        assertEquals(sends[0], sends[1])
        assertEquals(listOf(roomId), sent)
        until("stored event replaces the bubble") { state.events.any { it.getString("id") == "stored-" + entry.id } }
        assertTrue(state.localEvents.isEmpty())
        assertNull(saved)
    }

    @Test fun repeatedTransientFailuresKeepBackingOff() = runBlocking {
        val outbox = ChatOutbox(owner)
        val state = rooms(outbox)
        openRoom(state)
        state.draft = "Eventually"
        repeat(2) { sendResponses.add(MockResponse().setResponseCode(503).setBody("""{"message":"busy"}""")) }
        state.send(emptyList()) { _, _ -> }
        until("first attempt") { !state.busy && sends.size == 1 }
        clock += OUTBOX_FIRST_RETRY_MS
        state.pump { _, _ -> }
        until("second attempt") { sends.size == 2 && state.pendingSend?.attempts == 2 }
        assertEquals(clock + outboxRetryDelay(2), state.pendingSend!!.nextAttemptAt)
        assertEquals(clock + outboxRetryDelay(2), state.pump { _, _ -> })
        clock += outboxRetryDelay(2)
        state.pump { _, _ -> }
        until("third attempt accepted") { sends.size == 3 && state.pendingSend == null }
        assertEquals(1, sends.toSet().size)
    }

    @Test fun aRestartResendsTheFrozenBodyWithTheSameRequestId() = runBlocking {
        val outbox = ChatOutbox(owner)
        var saved: String? = null
        outbox.onChange = { saved = outbox.json() }
        val state = rooms(outbox)
        openRoom(state)
        state.draft = "Accepted, ACK lost"
        // The server stores the message, then the connection dies before the ACK
        // (OkHttp's own silent connection retry is off so the loss stays visible).
        val client = Api.client
        Api.client = client.newBuilder().retryOnConnectionFailure(false).build()
        try {
            sendResponses.add(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AFTER_REQUEST))
            state.send(emptyList()) { _, _ -> }
            until("first attempt") { !state.busy && sends.size == 1 }
        } finally { Api.client = client }
        assertNotNull(state.pendingSend)

        // A new process: the outbox blob is all that survived.
        val restored = ChatOutbox(owner, saved)
        val after = rooms(restored)
        assertEquals("unconfirmed", after.sendStatus(restored.entries.single()))
        after.pump { _, _ -> }
        until("resent") { sends.size == 2 && restored.entries.isEmpty() }
        assertEquals(sends[0], sends[1])
        assertEquals("Accepted, ACK lost", JSONObject(sends[1]).getString("content"))
    }

    @Test fun aDefinitiveRejectionWaitsForRetryOrDiscard() = runBlocking {
        val outbox = ChatOutbox(owner)
        val state = rooms(outbox)
        openRoom(state)
        state.draft = "Too late"
        sendResponses.add(MockResponse().setResponseCode(409).setBody("""{"message":"This conversation is closed or disabled"}"""))
        state.send(emptyList()) { _, _ -> }
        until("rejected") { !state.busy && state.pendingSend?.failed == true }
        assertEquals("failed", state.localEvents.single().getString("delivery_status"))
        clock += OUTBOX_MAX_RETRY_MS * 10
        assertNull("failed sends are never retried on their own", state.pump { _, _ -> })
        delay(100); assertEquals(1, sends.size)
        state.discard(state.pendingSend!!.id)
        assertNull(state.pendingSend)
        assertEquals("discarded text returns to the empty composer", "Too late", state.draft)
        // An explicit retry re-arms a failed send with the same id.
        state.draft = ""
        sendResponses.add(MockResponse().setResponseCode(403).setBody("""{"message":"no"}"""))
        state.draft = "Again"
        state.send(emptyList()) { _, _ -> }
        until("rejected again") { !state.busy && state.pendingSend?.failed == true }
        val id = state.pendingSend!!.id
        state.retry(id) { _, _ -> }
        until("retried") { state.pendingSend == null }
        assertEquals(JSONObject(sends[1]).getString("client_request_id"), JSONObject(sends[2]).getString("client_request_id"))
    }

    @Test fun roomsRenderFromTheCacheAndSignOutWipesEverything() = runBlocking {
        val outbox = ChatOutbox(owner)
        val state = rooms(outbox)
        state.refresh(Api(server.url("/").toString().trimEnd('/'), "test"), setOf("agent_messaging.read", "agent_messaging.reveal_content")) { true }
        openRoom(state)
        assertNotNull(savedRooms)
        state.draft = "Keep me"
        state.close()

        // Cold start offline: the directory and the room's recent events come from the cache.
        val coldOutbox = ChatOutbox(owner, outbox.json())
        val cold = RoomChats(scope, { Api("http://127.0.0.1:1", "test") }, { false }, coldOutbox, { savedRooms = if (it.isEmpty) null else it.json() }, {}, { clock }, owner)
        cold.restoreCache(RoomHistoryCache(owner, savedRooms))
        cold.open(JSONObject().put("id", roomId).put("status", "open"))
        assertEquals(listOf("server-1"), cold.events.map { it.getString("id") })
        assertEquals("Keep me", cold.draft)
        assertEquals("Earlier", cold.previews[roomId]!!.getString("content"))

        cold.clear()
        assertNull("sign-out deletes the room cache", savedRooms)
        assertNull(coldOutbox.draft("room:$roomId"))
        assertTrue(cold.events.isEmpty())
    }

    @Test fun losingRevealContentDropsCachedContentAndRoomSends() = runBlocking {
        val outbox = ChatOutbox(owner)
        val state = rooms(outbox)
        val client = Api(server.url("/").toString().trimEnd('/'), "test")
        state.refresh(client, setOf("agent_messaging.read", "agent_messaging.reveal_content")) { true }
        openRoom(state)
        state.draft = "Private draft"
        outbox.enqueue(OutboxEntry("e", "room:$roomId", "/rooms/send", "{}", "now"))
        outbox.enqueue(OutboxEntry("d", "agent", "/agents/agent/messages", "{}", "now"))
        assertTrue(savedRooms!!.contains("Earlier"))
        val wipes = state.cacheWipes
        state.refresh(client, setOf("agent_messaging.read")) { true }
        assertFalse(savedRooms!!.contains("Earlier"))
        assertTrue(savedRooms!!.contains(roomId))
        assertTrue(state.cacheWipes > wipes)
        assertEquals(listOf("d"), outbox.entries.map { it.id })
        assertNull(outbox.draft("room:$roomId"))
        assertTrue(state.events.isEmpty())
    }
}
