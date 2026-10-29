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
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** Delta sync of rooms (R3 C3) against a scripted server: cursors, has_more, resync, changes, fallback. */
class RoomDeltaTest {
    private val owner = ChatHistoryCache.owner(Connection("https://fleet.example", "t", "phone", null))
    private val roomId = "6f0e1c2b-0000-4000-8000-0000000000aa"
    private val server = MockWebServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    /** Path (with query) and body of every request. */
    private val requests = CopyOnWriteArrayList<Pair<String, String>>()
    @Volatile private var handler: (String, JSONObject) -> String = { _, _ -> "{}" }
    @Volatile private var saved: String? = null

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                val path = request.path!!.removePrefix("/companion/v1")
                requests.add(path to body)
                return MockResponse().setBody(handler(path, if (body.isBlank()) JSONObject() else JSONObject(body)))
            }
        }
        server.start()
    }
    @After fun stop() { scope.cancel(); server.close() }

    private fun client() = Api(server.url("/").toString().trimEnd('/'), "test")
    private fun state(protocols: RoomProtocols = RoomProtocols(delta = true)) =
        RoomChats(scope, ::client, { true }, ChatOutbox(owner), { saved = it.json() }, owner = owner, texts = TestTexts).apply { applyProtocols(protocols) }
    private fun event(id: String, second: Int, status: String? = null) = JSONObject().put("id", id).put("kind", "chat").put("content", "m$id").put("actor", "agent:a")
        .put("created_at", "2026-10-29T10:00:%02d.000Z".format(second))
        .apply { status?.let { put("deliveries", JSONArray().put(JSONObject().put("address_id", "x").put("status", it))) } }
    private fun room(unread: Int = 0, members: Int = 1) = JSONObject().put("id", roomId).put("status", "open").put("unread", unread).put("read_at", JSONObject.NULL)
        .put("members", JSONArray().apply { repeat(members) { put(JSONObject().put("id", "m$it").put("name", "Agent $it")) } })
    private fun delta(events: List<JSONObject>, next: Long, more: Boolean, room: JSONObject = room()) =
        JSONObject().put("room", room).put("resync", false).put("events", JSONArray(events)).put("changes", JSONArray()).put("next_after", next).put("has_more", more).toString()
    private fun full(events: List<JSONObject>, next: Long) = JSONObject().put("room", room()).put("events", JSONArray(events)).put("next_after", next).put("next_before", JSONObject.NULL).toString()
    private fun directory() = """{"rooms":[{"id":"$roomId","status":"open","title":"Release","unread":3}],"has_more":false,"next_offset":null}"""
    private fun reads() = requests.filter { it.first == "/rooms/read" }.map { JSONObject(it.second) }
    private fun savedCache() = RoomHistoryCache(owner, saved)
    private suspend fun until(message: String, condition: () -> Boolean) {
        withTimeout(5_000) { while (!condition()) delay(20) }
        assertTrue(message, condition())
    }
    /** A state whose room has a cached timeline current to change [after]. */
    private fun cached(after: Long, vararg events: JSONObject, hasEarlier: Boolean = false): RoomChats {
        val cache = RoomHistoryCache(owner).apply { rememberRooms(listOf(room())); rememberEvents(roomId, events.toList(), after, hasEarlier) }
        return state().apply { restoreCache(RoomHistoryCache(owner, cache.json())) }
    }

    @Test fun openingACachedRoomReadsOnlyTheDeltaAndFollowsHasMore() = runBlocking {
        val state = cached(10, event("e1", 1, "queued"), hasEarlier = true)
        handler = { path, body ->
            if (path != "/rooms/read") "{}"
            else if (body.getLong("after") == 10L) delta(listOf(event("e2", 2)), 20, more = true)
            else delta(listOf(event("e1", 1, "completed"), event("e2", 2), event("e0", 0)), 25, more = false, room = room(unread = 0, members = 2))
        }
        state.open(JSONObject().put("id", roomId).put("status", "open"))
        assertEquals("cached events render at once", listOf("e1"), state.events.map { it.getString("id") })
        assertEquals("the oldest cached event gives the history cursor", roomHistoryCursor(event("e1", 1)), state.nextBefore)
        until("delta pages read") { reads().size == 2 && !state.loading }
        assertEquals(listOf(10L, 20L), reads().map { it.getLong("after") })
        assertFalse("delta reads never ask for history", reads().any { it.has("before") })
        assertEquals("e0 predates the loaded history and waits for Earlier messages", listOf("e1", "e2"), state.events.map { it.getString("id") })
        assertEquals("completed", state.events[0].getJSONArray("deliveries").getJSONObject(0).getString("status"))
        assertEquals(2, state.current!!.getJSONArray("members").length())
        assertEquals(25L, savedCache().after(roomId))
        assertTrue(savedCache().hasEarlier(roomId))
    }

    @Test fun aResyncReadsTheRoomInFullAndContinuesFromThatRead() = runBlocking {
        val state = cached(3, event("e1", 1))
        handler = { path, body ->
            when {
                path != "/rooms/read" -> "{}"
                body.has("after") -> """{"room_id":"$roomId","resync":true,"next_after":12}"""
                else -> full(listOf(event("e5", 5), event("e6", 6)), 40)
            }
        }
        state.open(JSONObject().put("id", roomId).put("status", "open"))
        until("full read after resync") { reads().size == 2 && !state.loading }
        assertTrue(reads()[0].has("after"))
        assertFalse(reads()[1].has("after"))
        assertEquals(listOf("e1", "e5", "e6"), state.events.map { it.getString("id") })
        assertEquals(40L, savedCache().after(roomId))
        assertNull(state.error)
    }

    @Test fun endlessHasMoreIsCappedByAFullRead() = runBlocking {
        val state = cached(1, event("e1", 1))
        var next = 1L
        handler = { path, body ->
            when {
                path != "/rooms/read" -> "{}"
                body.has("after") -> delta(emptyList(), ++next, more = true)
                else -> full(listOf(event("e9", 9)), 500)
            }
        }
        state.open(JSONObject().put("id", roomId).put("status", "open"))
        until("capped") { reads().any { !it.has("after") } && !state.loading }
        assertEquals(ROOM_DELTA_MAX_PAGES, reads().count { it.has("after") })
        assertEquals(500L, savedCache().after(roomId))
    }

    @Test fun refreshAsksForChangesAndSkipsTheDirectoryWhenNothingChanged() = runBlocking {
        val state = state()
        var changed = JSONArray()
        handler = { path, body ->
            when {
                path.startsWith("/rooms/changes?after=0") -> """{"enabled":true,"rooms":[{"room_id":"$roomId","seq":50}],"next_after":50,"resync":false,"has_more":false}"""
                path.startsWith("/rooms/changes?after=50") -> JSONObject().put("enabled", true).put("rooms", changed).put("next_after", if (changed.length() > 0) 60 else 50).put("resync", false).put("has_more", false).toString()
                path.startsWith("/rooms/changes") -> """{"enabled":true,"rooms":[],"next_after":60,"resync":false,"has_more":false}"""
                path.startsWith("/rooms?") -> directory()
                path == "/rooms/read" && !body.has("after") -> full(listOf(event("e1", 1)), 50)
                path == "/rooms/read" -> delta(listOf(event("e2", 2)), 60, more = false)
                else -> "{}"
            }
        }
        val caps = setOf("agent_messaging.read", "agent_messaging.reveal_content")
        state.refresh(client(), caps) { true }
        assertEquals(listOf("/rooms/changes?after=0"), requests.map { it.first }.filter { it.startsWith("/rooms/changes") })
        assertEquals(1, requests.count { it.first.startsWith("/rooms?") })
        assertEquals(50L, savedCache().changesAfter)
        state.open(state.rooms.single())
        until("opened") { reads().size == 1 && !state.loading }
        requests.clear()
        state.refresh(client(), caps, full = false) { true }
        assertEquals("nothing changed: no directory and no room read", listOf("/rooms/changes?after=50"), requests.map { it.first })
        changed = JSONArray().put(JSONObject().put("room_id", roomId).put("seq", 60))
        requests.clear()
        state.refresh(client(), caps, full = false) { true }
        assertEquals(listOf("/rooms/changes?after=50", "/rooms?view=active&offset=0", "/rooms/read"), requests.map { it.first })
        assertEquals(50L, reads().single().getLong("after"))
        assertEquals(listOf("e1", "e2"), state.events.map { it.getString("id") })
        assertEquals(60L, savedCache().changesAfter)
        assertEquals(60L, savedCache().after(roomId))
    }

    @Test fun changesResyncReloadsEverything() = runBlocking {
        val state = state()
        handler = { path, _ ->
            when {
                path.startsWith("/rooms/changes?after=0") -> """{"enabled":true,"rooms":[],"next_after":5,"resync":false,"has_more":false}"""
                path.startsWith("/rooms/changes") -> """{"enabled":true,"rooms":[],"next_after":90,"resync":true,"has_more":false}"""
                path.startsWith("/rooms?") -> directory()
                else -> "{}"
            }
        }
        val caps = setOf("agent_messaging.read")
        state.refresh(client(), caps) { true }
        requests.clear()
        state.refresh(client(), caps, full = false) { true }
        assertEquals(listOf("/rooms/changes?after=5", "/rooms?view=active&offset=0"), requests.map { it.first })
        assertEquals(90L, savedCache().changesAfter)
    }

    @Test fun olderServersKeepFullReadsAndNeverAskForChanges() = runBlocking {
        val state = state(RoomProtocols())
        handler = { path, _ ->
            when {
                path.startsWith("/rooms?") -> directory()
                path == "/rooms/read" -> """{"room":{"id":"$roomId","status":"open","members":[]},"events":[${event("e1", 1)}],"next_before":null}"""
                else -> "{}"
            }
        }
        state.refresh(client(), setOf("agent_messaging.read", "agent_messaging.reveal_content")) { true }
        state.open(state.rooms.single())
        until("read") { reads().size == 1 && !state.loading }
        state.refresh(client(), setOf("agent_messaging.read", "agent_messaging.reveal_content"), full = false) { true }
        assertFalse(requests.any { it.first.startsWith("/rooms/changes") })
        assertTrue(reads().none { it.has("after") })
        assertEquals(2, reads().size)
        assertNull("no cursor without the protocol", savedCache().after(roomId))
        assertEquals("the directory row keeps the server's unread count", 3, state.rooms.single().getInt("unread"))
    }

    @Test fun notificationModeLoadsAndSavesOnlyWithTheProtocol() = runBlocking {
        handler = { path, body ->
            when {
                path == "/rooms/$roomId/notifications" && body.has("mode") -> JSONObject().put("room_id", roomId).put("mode", body.getString("mode")).toString()
                path == "/rooms/$roomId/notifications" -> """{"room_id":"$roomId","mode":"default"}"""
                path == "/rooms/read" -> full(listOf(event("e1", 1)), 1)
                else -> "{}"
            }
        }
        val off = state(RoomProtocols(delta = true))
        off.open(JSONObject().put("id", roomId).put("status", "open"))
        off.loadNotificationMode(); off.changeNotificationMode("mute")
        delay(200)
        assertFalse(requests.any { it.first.endsWith("/notifications") })
        val on = state(RoomProtocols(delta = true, notifications = true))
        on.open(JSONObject().put("id", roomId).put("status", "open"))
        on.loadNotificationMode()
        until("loaded") { on.notificationMode == "default" }
        on.changeNotificationMode("follow")
        assertEquals("the choice shows at once", "follow", on.notificationMode)
        until("saved") { requests.any { it.first.endsWith("/notifications") && it.second.contains("follow") } }
        on.changeNotificationMode("loud")
        assertEquals("follow", on.notificationMode)
    }

    @Test fun activityFramesShowUntilTheirTtl() {
        var clock = 1_000L
        val state = RoomChats(scope, ::client, { true }, now = { clock }, texts = TestTexts)
        state.activity(LiveFrame.RoomActivity(roomId, listOf(RoomActivityActor("m0", "Agent 0", "working")), 8))
        assertEquals(listOf("m0"), state.activeActors(roomId).map { it.addressId })
        clock = 9_000
        assertTrue(state.activeActors(roomId).isEmpty())
        state.activity(LiveFrame.RoomActivity(roomId, listOf(RoomActivityActor("m0", "Agent 0", "working")), 8))
        state.activity(LiveFrame.RoomActivity(roomId, emptyList(), 0))
        assertTrue(state.activeActors(roomId).isEmpty())
        state.activity(LiveFrame.RoomActivity(roomId, listOf(RoomActivityActor("m0", "Agent 0", "working")), 8))
        state.clear()
        assertTrue("activity is never kept past a wipe", state.activity.isEmpty())
    }
}
