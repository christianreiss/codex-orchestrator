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
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** Reactions, pins and search (R5 C6) against a scripted server: optimistic toggles, rollback, merges, cache, pagination. */
class RoomAnnotationsStateTest {
    private val owner = ChatHistoryCache.owner(Connection("https://fleet.example", "t", "phone", null))
    private val roomId = "6f0e1c2b-0000-4000-8000-0000000000aa"
    private val server = MockWebServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val requests = CopyOnWriteArrayList<Triple<String, String, String>>()
    @Volatile private var handler: (String, String, JSONObject) -> MockResponse = { _, _, _ -> MockResponse().setBody("{}") }
    @Volatile private var saved: String? = null

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                val path = request.path!!.removePrefix("/companion/v1")
                requests.add(Triple(request.method!!, path, body))
                return handler(request.method!!, path, if (body.isBlank()) JSONObject() else JSONObject(body))
            }
        }
        server.start()
    }
    @After fun stop() { scope.cancel(); server.close() }

    private fun client() = Api(server.url("/").toString().trimEnd('/'), "test")
    private fun ok(json: String) = MockResponse().setBody(json)
    private fun error(status: Int, code: String, message: String = "failed", retryAfter: Int? = null) =
        MockResponse().setResponseCode(status).setBody(JSONObject().put("status", "error").put("message", message).put("code", code).toString())
            .apply { retryAfter?.let { addHeader("Retry-After", it.toString()) } }
    private fun state(protocols: RoomProtocols = RoomProtocols(delta = true, reactions = true, pins = true)) =
        RoomChats(scope, ::client, { true }, ChatOutbox(owner), { saved = it.json() }, owner = owner, texts = TestTexts).apply { applyProtocols(protocols) }
    private fun reaction(emoji: String, count: Int, mine: Boolean) = JSONObject().put("emoji", emoji).put("count", count).put("mine", mine)
    private fun event(id: String, second: Int, vararg reactions: JSONObject, legacy: Boolean = false) = JSONObject().put("id", id).put("kind", "chat").put("content", "m$id").put("actor", "agent:a")
        .put("created_at", "2026-10-29T10:00:%02d.000Z".format(second)).apply { if (!legacy) put("reactions", JSONArray(reactions.toList())) }
    private fun room() = JSONObject().put("id", roomId).put("status", "open").put("unread", 0).put("members", JSONArray())
    private fun full(events: List<JSONObject>, next: Long, pinned: List<String>? = null) =
        JSONObject().put("room", room()).put("events", JSONArray(events)).put("next_after", next).put("next_before", JSONObject.NULL)
            .apply { pinned?.let { put("pinned", JSONArray(it)) } }.toString()
    private fun delta(events: List<JSONObject>, next: Long, pinned: List<String>? = null) =
        JSONObject().put("room", room()).put("resync", false).put("events", JSONArray(events)).put("changes", JSONArray()).put("next_after", next).put("has_more", false)
            .apply { pinned?.let { put("pinned", JSONArray(it)) } }.toString()
    private fun savedCache() = RoomHistoryCache(owner, saved)
    private suspend fun until(message: String, condition: () -> Boolean) {
        withTimeout(5_000) { while (!condition()) delay(20) }
        assertTrue(message, condition())
    }
    /** An open room holding [events], current to change 10, with [pinned] pins. */
    private fun opened(events: List<JSONObject>, pinned: List<String> = emptyList(), protocols: RoomProtocols = RoomProtocols(delta = true, reactions = true, pins = true)): RoomChats {
        val cache = RoomHistoryCache(owner).apply { rememberRooms(listOf(room())); rememberEvents(roomId, events, 10, false); rememberPinned(roomId, pinned) }
        val state = state(protocols).apply { restoreCache(RoomHistoryCache(owner, cache.json())) }
        handler = { _, path, _ -> if (path == "/rooms/read") ok(delta(emptyList(), 10)) else ok("{}") }
        state.open(JSONObject().put("id", roomId).put("status", "open"))
        return state
    }
    private fun chips(state: RoomChats, id: String) = roomReactions(state.events.first { it.getString("id") == id })

    @Test fun aToggleChangesTheChipAtOnceThenTheAnswerReplacesIt() = runBlocking {
        val state = opened(listOf(event("e1", 1, reaction("👍", 1, false))))
        until("opened") { !state.loading && requests.any { it.second == "/rooms/read" } }
        handler = { _, path, _ ->
            if (path.endsWith("/reactions")) { Thread.sleep(150); ok("""{"room_id":"$roomId","event_id":"e1","emoji":"❤️","on":true,"changed":true,"reactions":[{"emoji":"👍","count":4,"mine":false},{"emoji":"❤️","count":1,"mine":true}]}""") } else ok("{}")
        }
        state.react("e1", "❤️")
        assertEquals("optimistic chip", listOf(RoomReaction("👍", 1, false), RoomReaction("❤️", 1, true)), chips(state, "e1"))
        until("server answer applied") { chips(state, "e1")?.firstOrNull { it.emoji == "👍" }?.count == 4 }
        val post = requests.last { it.second.endsWith("/reactions") }
        assertEquals("POST", post.first)
        assertEquals("/rooms/$roomId/events/e1/reactions", post.second)
        val body = JSONObject(post.third)
        assertEquals("❤️", body.getString("emoji")); assertTrue(body.getBoolean("on")); assertTrue(body.getString("client_request_id").isNotBlank())
        assertEquals("the offline copy carries the reactions", listOf(RoomReaction("👍", 4, false), RoomReaction("❤️", 1, true)), roomReactions(savedCache().events(roomId).single()))
    }

    @Test fun tappingYourOwnChipRemovesIt() = runBlocking {
        val state = opened(listOf(event("e1", 1, reaction("👍", 2, true))))
        until("opened") { !state.loading && requests.any { it.second == "/rooms/read" } }
        handler = { _, _, _ -> ok("""{"changed":true,"reactions":[{"emoji":"👍","count":1,"mine":false}]}""") }
        state.react("e1", "👍")
        assertEquals(listOf(RoomReaction("👍", 1, false)), chips(state, "e1"))
        until("sent") { requests.any { it.second.endsWith("/reactions") } }
        assertFalse(JSONObject(requests.last { it.second.endsWith("/reactions") }.third).getBoolean("on"))
    }

    @Test fun aRejectedToggleRollsBackAndExplainsTheLimit() = runBlocking {
        val state = opened(listOf(event("e1", 1, reaction("👍", 1, false))))
        until("opened") { !state.loading && requests.any { it.second == "/rooms/read" } }
        handler = { _, path, _ -> if (path.endsWith("/reactions")) error(409, "reaction_limit") else ok("{}") }
        state.react("e1", "🎉")
        until("rolled back with a message") { state.annotationNotice != null }
        assertEquals(listOf(RoomReaction("👍", 1, false)), chips(state, "e1"))
        assertEquals(TestTexts.string(R.string.reaction_limit), state.annotationNotice)
        assertEquals(listOf(RoomReaction("👍", 1, false)), roomReactions(savedCache().events(roomId).single()))
    }

    @Test fun rateLimitsNameTheWaitAndAnUnconfirmedToggleRepeatsItsRequestId() = runBlocking {
        val state = opened(listOf(event("e1", 1, reaction("👍", 1, false))))
        until("opened") { !state.loading && requests.any { it.second == "/rooms/read" } }
        handler = { _, path, _ -> if (path.endsWith("/reactions")) error(429, "rate_limited", retryAfter = 7) else ok("{}") }
        state.react("e1", "🎉")
        until("rate limit message") { state.annotationNotice != null }
        assertEquals("Too many changes. Try again in 7 seconds.", state.annotationNotice)
        // A lost connection leaves the outcome unknown: the retry carries the same client_request_id.
        handler = { _, path, _ -> if (path.endsWith("/reactions")) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START) else ok("{}") }
        state.clearAnnotationNotice()
        state.react("e1", "👀")
        until("failed") { state.annotationNotice != null }
        assertEquals("rolled back after the lost connection", listOf(RoomReaction("👍", 1, false)), chips(state, "e1"))
        handler = { _, path, _ -> if (path.endsWith("/reactions")) ok("""{"changed":true,"reactions":[{"emoji":"👍","count":1,"mine":false},{"emoji":"👀","count":1,"mine":true}]}""") else ok("{}") }
        state.react("e1", "👀")
        until("retry answered") { chips(state, "e1")?.size == 2 && requests.count { it.second.endsWith("/reactions") } >= 3 }
        val ids = requests.filter { it.second.endsWith("/reactions") && JSONObject(it.third).getString("emoji") == "👀" }.map { JSONObject(it.third).getString("client_request_id") }
        assertTrue("at least the failed attempt and the retry", ids.size >= 2)
        assertEquals("the retry reuses the id", 1, ids.toSet().size)
    }

    @Test fun legacyEventsAndServersWithoutTheProtocolShowAndSendNothing() = runBlocking {
        val legacy = opened(listOf(event("old", 1, legacy = true)))
        until("opened") { !legacy.loading && requests.any { it.second == "/rooms/read" } }
        val before = requests.size
        legacy.react("old", "👍")
        delay(150)
        assertNull(chips(legacy, "old"))
        assertEquals("no request for an event without a reactions field", before, requests.size)
        requests.clear()
        val off = opened(listOf(event("e1", 1)), protocols = RoomProtocols(delta = true))
        until("opened") { !off.loading && requests.any { it.second == "/rooms/read" } }
        off.react("e1", "👍"); off.pin("e1", true)
        delay(150)
        assertTrue(requests.none { it.second.endsWith("/reactions") || it.second.endsWith("/pin") })
        assertTrue(off.pinned.isEmpty())
    }

    @Test fun aDeltaWithReactionAndPinChangesUpsertsTheEventAndReplacesThePinnedList() = runBlocking {
        val state = opened(listOf(event("e1", 1, reaction("👍", 1, false)), event("e2", 2)), pinned = listOf("e1"))
        until("opened") { !state.loading && requests.any { it.second == "/rooms/read" } }
        assertEquals(listOf("e1"), state.pinned)
        handler = { _, path, body ->
            if (path == "/rooms/read" && body.has("after")) ok(delta(listOf(event("e1", 1, reaction("👍", 2, true), reaction("🎉", 1, false))), 20, pinned = listOf("e2")))
            else ok("{}")
        }
        state.retryRead()
        until("merged") { state.pinned == listOf("e2") }
        assertEquals(listOf("e1", "e2"), state.events.map { it.getString("id") })
        assertEquals(listOf(RoomReaction("👍", 2, true), RoomReaction("🎉", 1, false)), chips(state, "e1"))
        assertEquals("the pin list is replaced, not merged", listOf("e2"), savedCache().pinned(roomId))
        assertEquals(listOf(RoomReaction("👍", 2, true), RoomReaction("🎉", 1, false)), roomReactions(savedCache().events(roomId).first()))
        // A delta without a `pinned` field leaves the list alone; an empty array clears it.
        handler = { _, path, _ -> if (path == "/rooms/read") ok(delta(emptyList(), 21)) else ok("{}") }
        state.retryRead()
        until("no change") { requests.count { it.second == "/rooms/read" } >= 3 && !state.loading }
        assertEquals(listOf("e2"), state.pinned)
        handler = { _, path, _ -> if (path == "/rooms/read") ok(delta(emptyList(), 22, pinned = emptyList())) else ok("{}") }
        state.retryRead()
        until("cleared") { state.pinned.isEmpty() }
    }

    @Test fun aFullReadAlsoCarriesReactionsAndPins() = runBlocking {
        val state = state()
        handler = { _, path, _ -> if (path == "/rooms/read") ok(full(listOf(event("e1", 1, reaction("✅", 3, true))), 5, pinned = listOf("e1"))) else ok("{}") }
        state.open(JSONObject().put("id", roomId).put("status", "open"))
        until("read") { state.events.isNotEmpty() && !state.loading }
        assertEquals(listOf(RoomReaction("✅", 3, true)), chips(state, "e1"))
        assertEquals(listOf("e1"), state.pinned)
        assertEquals(listOf("e1"), savedCache().pinned(roomId))
    }

    @Test fun pinningIsOptimisticAdoptsTheServerListAndRollsBackOnTheLimit() = runBlocking {
        val state = opened(listOf(event("e1", 1), event("e2", 2)), pinned = listOf("e1"))
        until("opened") { !state.loading && requests.any { it.second == "/rooms/read" } }
        handler = { _, path, _ -> if (path.endsWith("/pin")) { Thread.sleep(100); ok("""{"room_id":"$roomId","event_id":"e2","on":true,"changed":true,"pinned":["e2","e1"]}""") } else ok("{}") }
        state.pin("e2", true)
        assertEquals("newest pin first at once", listOf("e2", "e1"), state.pinned)
        until("answered") { requests.any { it.second.endsWith("/pin") } && savedCache().pinned(roomId) == listOf("e2", "e1") }
        val body = JSONObject(requests.last { it.second.endsWith("/pin") }.third)
        assertTrue(body.getBoolean("on")); assertTrue(body.getString("client_request_id").isNotBlank())
        handler = { _, path, _ -> if (path.endsWith("/pin")) error(409, "room_pin_limit") else ok("{}") }
        state.pin("e1", false)
        until("rolled back") { state.annotationNotice != null }
        assertEquals("the failed unpin restores the pin", listOf("e2", "e1"), state.pinned)
        assertEquals(TestTexts.string(R.string.pin_limit), state.annotationNotice)
    }

    @Test fun thePinListLoadsWithSnippetsAndRemovedEventsStayListed() = runBlocking {
        val state = opened(listOf(event("e1", 1)), pinned = listOf("e1", "gone"))
        until("opened") { !state.loading && requests.any { it.second == "/rooms/read" } }
        handler = { _, path, _ -> if (path.endsWith("/pins")) ok("""{"room_id":"$roomId","pins":[{"event_id":"e1","pinned_by":"admin:1","pinned_at":"2026-10-29T10:00:00Z","event":{"id":"e1","created_at":"2026-10-29T10:00:01Z","actor":"agent:a","name":"Ada","kind":"chat","snippet":"hello","attachments":[]}},{"event_id":"gone","pinned_by":"admin:1","pinned_at":"2026-10-28T10:00:00Z","event":null}]}""") else ok("{}") }
        state.loadPins()
        until("loaded") { state.pinsLoaded }
        assertEquals(listOf("hello", null), state.pinEntries.map { it.snippet })
    }

    @Test fun aSearchJumpWaitsForTheFirstReadAfterOpening() = runBlocking {
        val state = state()
        handler = { _, path, _ -> if (path == "/rooms/read") ok(full(listOf(event("e1", 1)), 5)) else ok("{}") }
        state.open(JSONObject().put("id", roomId).put("status", "open"))
        state.requestJump("e1")
        assertEquals("e1", state.jumpTarget)
        assertEquals(0, state.jumpAfterSyncs)
        until("first read done") { state.syncs > state.jumpAfterSyncs }
        state.jumpHandled()
        assertNull(state.jumpTarget)
    }

    // ---- search ----

    private fun searchState() = MessageSearch(scope, ::client, TestTexts)
    private fun hitJson(event: String) = """{"scope":"room","conversation_key":"room:$roomId","conversation_id":"$roomId","title":"Release","event_id":"$event","created_at":"2026-10-29T10:00:00Z","actor":"agent:a","author":"Ada","snippet":"a release note","highlights":[{"start":2,"length":7}]}"""

    @Test fun searchPaginatesWithTheOpaqueCursorAndAppendsOlderHits() = runBlocking {
        val search = searchState()
        handler = { _, path, _ ->
            if (path.contains("cursor=")) ok("""{"results":[${hitJson("e2")}],"next_cursor":null,"truncated":false,"scanned":10,"scopes":["rooms"]}""")
            else ok("""{"results":[${hitJson("e1")}],"next_cursor":"c1==","truncated":true,"scanned":2000,"scopes":["rooms"]}""")
        }
        search.update("release")
        search.run()
        until("first page") { search.answered && !search.loading }
        assertEquals(listOf("e1"), search.hits.map { it.eventId })
        assertEquals("c1==", search.nextCursor); assertTrue(search.truncated)
        assertEquals("/search?q=release&scope=all&limit=20", requests.last().second)
        search.older()
        until("second page") { search.hits.size == 2 && !search.loading }
        assertEquals(listOf("e1", "e2"), search.hits.map { it.eventId })
        assertNull(search.nextCursor)
        assertEquals("/search?q=release&scope=all&limit=20&cursor=c1%3D%3D", requests.last().second)
        assertEquals("highlights map to snippet indices", "release", search.hits[0].snippet.substring(search.hits[0].highlights[0].first, search.hits[0].highlights[0].last + 1))
    }

    @Test fun changingTheQueryOrScopeDropsStaleResultsAndShortQueriesSendNothing() = runBlocking {
        val search = searchState()
        handler = { _, _, _ -> ok("""{"results":[${hitJson("e1")}],"next_cursor":null,"truncated":false}""") }
        search.update("r"); search.run()
        delay(150)
        assertTrue("one character is never sent", requests.isEmpty())
        search.update("release"); search.run()
        until("answered") { search.answered }
        search.update(newScope = SearchScope.Direct)
        assertTrue(search.hits.isEmpty()); assertFalse(search.answered)
        search.run()
        until("direct answered") { search.answered }
        assertTrue(requests.last().second.contains("scope=direct"))
    }

    @Test fun searchRateLimitShowsTheRetryAfterWait() = runBlocking {
        val search = searchState()
        handler = { _, _, _ -> error(429, "rate_limited", retryAfter = 42) }
        search.update("release"); search.run()
        until("error") { search.error != null }
        assertEquals("Too many searches. Try again in 42 seconds.", search.error)
        assertTrue(search.hits.isEmpty())
    }
}
