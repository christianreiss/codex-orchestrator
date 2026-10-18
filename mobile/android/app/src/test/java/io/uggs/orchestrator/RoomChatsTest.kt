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
    @Test fun paginationReconcilesByIdentityAndKeepsEqualTimeEvents() {
        fun event(id: String, text: String) = JSONObject().put("id", id).put("content", text).put("created_at", "2026-10-18T09:00:00Z")
        val result = mergeRoomEvents(listOf(event("b", "old")), listOf(event("a", "earlier"), event("b", "updated")))
        assertEquals(listOf("a", "b"), result.map { it.getString("id") })
        assertEquals("updated", result[1].getString("content"))
    }
    @Test fun nullNamesNeverBecomeVisibleLabels() {
        assertEquals("Review agent", roomPersonLabel(JSONObject().put("name", JSONObject.NULL).put("alias", "Review agent")))
    }
    @Test fun aLateReadCannotRestorePrivateContentAfterClearing() = runBlocking {
        val server = MockWebServer()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            server.enqueue(MockResponse().setBody("""{"room":{"id":"room"},"events":[{"id":"event","content":"private","created_at":"2026-10-18T09:00:00Z"}],"next_before":null}""").setBodyDelay(400, TimeUnit.MILLISECONDS))
            server.start()
            val rooms = RoomChats(scope, { Api(server.url("/").toString().trimEnd('/'), "test") }, { true })
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
