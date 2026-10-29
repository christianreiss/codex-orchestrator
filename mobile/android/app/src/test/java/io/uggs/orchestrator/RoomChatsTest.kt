package io.uggs.orchestrator

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class RoomChatsTest {
    @Test fun roomsNeedAtLeastOneRemainingActiveMember() {
        fun member(engine: String, reachable: Boolean) = JSONObject().put("engine", engine).put("reachable", reachable)
        fun room(vararg members: JSONObject) = JSONObject().put("members", org.json.JSONArray(members.toList()))
        assertFalse(roomHasActiveAgent(JSONObject()))
        assertFalse(roomHasActiveAgent(room()))
        assertFalse(roomHasActiveAgent(room(JSONObject(), member("claude", false))))
        for (engine in listOf("codex", "claude", "grok")) {
            val online = member(engine, true)
            val mixed = room(member("codex", false), online, member("grok", false))
            assertTrue(roomHasActiveAgent(mixed))
            online.put("reachable", false)
            assertFalse(roomHasActiveAgent(mixed))
        }
    }
    @Test fun memberPresenceFollowsTheOnlineAgentRules() {
        fun agent(id: String, presence: String, readOnly: Boolean = false) =
            JSONObject().put("id", id).put("portal_session_id", "p-$id").put("presence", presence).put("read_only", readOnly)
        fun member(session: String?, reachable: Boolean = true) = JSONObject().put("session_id", session ?: JSONObject.NULL).put("reachable", reachable)
        val agents = listOf(agent("w", "working"), agent("l", "listening"), agent("i", "idle"), agent("ro", "idle", true), agent("gone", "ended"))
        assertEquals("working", roomMemberPresence(member("w"), agents))
        assertEquals("listening", roomMemberPresence(member("l"), agents))
        assertEquals("idle", roomMemberPresence(member("i"), agents))
        assertEquals("working", roomMemberPresence(member("p-w"), agents))
        for (session in listOf("ro", "gone", "unlisted", null)) assertEquals(session, "offline", roomMemberPresence(member(session), agents))
        assertEquals("offline", roomMemberPresence(member("w", reachable = false), agents))
        assertEquals("available", roomMemberPresence(member("w"), null))
        assertEquals("offline", roomMemberPresence(member("w", reachable = false), null))
    }
    @Test fun readMarkersSitUnderTheNewestEventAnAgentHasSeen() {
        fun event(id: String, at: String) = JSONObject().put("id", id).put("created_at", at)
        fun member(id: String, through: String?) = JSONObject().put("id", id).put("read_through", through ?: JSONObject.NULL)
        val events = listOf(event("a", "2026-10-26T05:00:00.000Z"), event("b", "2026-10-26T05:10:00.000Z"), event("c", "2026-10-26T05:20:00.000Z"))
        val markers = roomReadMarkers(events, listOf(
            member("exact", "2026-10-26T05:10:00.000Z"), member("between", "2026-10-26T05:15:00.000Z"), member("all", "2026-10-26T06:00:00.000Z"),
            member("early", "2026-10-26T04:00:00.000Z"), member("never", null),
        ))
        assertEquals(listOf("exact", "between"), markers["b"]!!.map { it.getString("id") })
        assertEquals(listOf("all"), markers["c"]!!.map { it.getString("id") })
        assertNull(markers["a"])
        assertEquals(setOf("b", "c"), markers.keys)
        assertTrue(roomReadMarkers(emptyList(), listOf(member("all", "2026-10-26T06:00:00.000Z"))).isEmpty())
    }
    @Test fun roomMembersMustAlsoBeOnlineAgentsByTheChatsRules() {
        fun agent(id: String, presence: String, readOnly: Boolean = false) =
            JSONObject().put("id", id).put("presence", presence).put("read_only", readOnly)
        fun room(vararg ids: String) = JSONObject().put("members", org.json.JSONArray(ids.map {
            JSONObject().put("session_id", it).put("reachable", true)
        }))
        val agents = listOf(agent("live", "listening"), agent("ro", "idle", true), agent("on", "online"), agent("gone", "ended"))
        assertTrue(roomHasActiveAgent(room("live"), agents))
        assertTrue(roomHasActiveAgent(room("ro", "live"), agents))
        for (id in listOf("ro", "on", "gone", "unlisted")) assertFalse(id, roomHasActiveAgent(room(id), agents))
        assertFalse(roomHasActiveAgent(room("live"), emptyList()))
        assertFalse(roomHasActiveAgent(JSONObject().put("members", org.json.JSONArray().put(JSONObject().put("session_id", "live").put("reachable", false))), agents))
        val daemon = JSONObject().put("id", "daemon").put("portal_session_id", "portal").put("presence", "working")
        assertTrue(roomHasActiveAgent(room("portal"), listOf(daemon)))
        assertTrue(roomHasActiveAgent(room("anything"), null))
    }
    @Test fun switchingToHistoryUsesItsOwnDirectoryAndPagination() = runBlocking {
        val server = MockWebServer()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            server.start()
            val client = Api(server.url("/").toString().trimEnd('/'), "test")
            val rooms = RoomChats(scope, { client }, { true }, texts = TestTexts)
            server.enqueue(MockResponse().setBody("""{"rooms":[{"id":"active"}],"has_more":false,"next_offset":null}"""))
            rooms.refresh(client, setOf("agent_messaging.read")) { true }
            assertTrue(server.takeRequest(2, TimeUnit.SECONDS)!!.path!!.contains("view=active"))
            rooms.showHistory(true)
            assertTrue(rooms.rooms.isEmpty())
            server.enqueue(MockResponse().setBody("""{"rooms":[{"id":"closed"}],"has_more":true,"next_offset":50}"""))
            rooms.refresh(client, setOf("agent_messaging.read")) { true }
            assertTrue(server.takeRequest(2, TimeUnit.SECONDS)!!.path!!.contains("view=history"))
            assertEquals("closed", rooms.rooms.single().getString("id"))
            server.enqueue(MockResponse().setBody("""{"rooms":[{"id":"older"}],"has_more":false,"next_offset":null}"""))
            rooms.more()
            val more = server.takeRequest(2, TimeUnit.SECONDS)!!.requestUrl!!
            assertEquals("history", more.queryParameter("view"))
            assertEquals("50", more.queryParameter("offset"))
            rooms.showHistory(false)
            assertNull(rooms.nextOffset)
            assertTrue(rooms.rooms.isEmpty())
        } finally { scope.cancel(); server.close() }
    }
    @Test fun paginationReconcilesByIdentityAndKeepsEqualTimeEvents() {
        fun event(id: String, text: String) = JSONObject().put("id", id).put("content", text).put("created_at", "2026-10-18T09:00:00Z")
        val result = mergeRoomEvents(listOf(event("b", "old")), listOf(event("a", "earlier"), event("b", "updated")))
        assertEquals(listOf("a", "b"), result.map { it.getString("id") })
        assertEquals("updated", result[1].getString("content"))
    }
    @Test fun nullNamesNeverBecomeVisibleLabels() {
        assertEquals("Review agent", roomPersonLabel(TestTexts, JSONObject().put("name", JSONObject.NULL).put("alias", "Review agent")))
    }
    @Test fun aLateReadCannotRestorePrivateContentAfterClearing() = runBlocking {
        val server = MockWebServer()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            server.enqueue(MockResponse().setBody("""{"room":{"id":"room"},"events":[{"id":"event","content":"private","created_at":"2026-10-18T09:00:00Z"}],"next_before":null}""").setBodyDelay(400, TimeUnit.MILLISECONDS))
            server.start()
            val rooms = RoomChats(scope, { Api(server.url("/").toString().trimEnd('/'), "test") }, { true }, texts = TestTexts)
            rooms.open(JSONObject().put("id", "room"))
            assertNotNull(server.takeRequest(2, TimeUnit.SECONDS))
            rooms.clear()
            delay(650)
            assertNull(rooms.selected)
            assertNull(rooms.current)
            assertTrue(rooms.events.isEmpty())
        } finally { scope.cancel(); server.close() }
    }
}
