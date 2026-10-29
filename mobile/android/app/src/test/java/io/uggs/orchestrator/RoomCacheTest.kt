package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RoomCacheTest {
    private val owner = ChatHistoryCache.owner(Connection("https://fleet.example", "private-token", "phone", null))
    private fun room(id: String) = JSONObject().put("id", id).put("title", "Room $id").put("status", "open").put("unread", 2)
        .put("members", JSONArray().put(JSONObject().put("id", "m-$id").put("reachable", true)))
    private fun event(id: Int, content: String = "Message $id") = JSONObject().put("id", "e$id").put("kind", "chat")
        .put("content", content).put("created_at", "2026-10-29T10:%02d:00Z".format(id % 60))

    @Test fun roomsAndRecentEventsRestoreWithoutLivePresence() {
        val cache = RoomHistoryCache(owner)
        cache.rememberRooms(listOf(room("a"), room("b")))
        cache.rememberEvents("a", listOf(event(1), event(2)))
        val restored = RoomHistoryCache(owner, cache.json())
        assertEquals(listOf("a", "b"), restored.rooms().map { it.getString("id") })
        val row = restored.rooms().first()
        assertTrue(row.getBoolean("cached"))
        assertFalse(row.getJSONArray("members").getJSONObject(0).getBoolean("reachable"))
        assertEquals(2, row.getInt("unread"))
        assertEquals(listOf("e1", "e2"), restored.events("a").map { it.getString("id") })
        assertTrue(restored.events("b").isEmpty())
        assertFalse(cache.json().contains("private-token"))
    }

    @Test fun keepsTheNewestEventsOfTheMostRecentlyReadRooms() {
        val cache = RoomHistoryCache(owner)
        cache.rememberEvents("a", (1..150).map { event(it) })
        assertEquals(RoomHistoryCache.MAX_EVENTS, cache.events("a").size)
        assertEquals("e150", cache.events("a").last().getString("id"))
        assertEquals("e51", cache.events("a").first().getString("id"))
        repeat(RoomHistoryCache.MAX_TIMELINES) { cache.rememberEvents("r$it", listOf(event(it))) }
        assertTrue("the least recently read room goes first", cache.events("a").isEmpty())
        cache.rememberEvents("r0", listOf(event(1), event(2)))
        cache.rememberEvents("new", listOf(event(3)))
        assertEquals(2, cache.events("r0").size)
        assertTrue(cache.events("r1").isEmpty())
    }

    @Test fun sizeBudgetHalvesThenDropsOldTimelines() {
        val big = "x".repeat(30 * 1024)
        val cache = RoomHistoryCache(owner)
        cache.rememberEvents("old", (1..40).map { event(it, big) })
        cache.rememberEvents("new", (1..40).map { event(it, big) })
        assertTrue(cache.json().toByteArray().size <= RoomHistoryCache.MAX_BYTES)
        assertTrue(cache.events("old").isEmpty())
        assertEquals(40, cache.events("new").size)
        cache.rememberEvents("new", (1..100).map { event(it, big) })
        assertTrue(cache.json().toByteArray().size <= RoomHistoryCache.MAX_BYTES)
        assertEquals("e100", cache.events("new").last().getString("id"))
        assertTrue(cache.events("new").size < 100)
    }

    @Test fun losingContentAccessKeepsOnlyTheDirectory() {
        val cache = RoomHistoryCache(owner).apply { rememberRooms(listOf(room("a"))); rememberEvents("a", listOf(event(1))) }
        cache.stripContent()
        val restored = RoomHistoryCache(owner, cache.json())
        assertEquals(1, restored.rooms().size)
        assertTrue(restored.events("a").isEmpty())
        assertFalse(cache.json().contains("Message 1"))
        cache.clear()
        assertTrue(cache.isEmpty)
    }

    @Test fun corruptForeignAndOldBlobsRestoreAsEmpty() {
        val good = RoomHistoryCache(owner).apply { rememberRooms(listOf(room("a"))); rememberEvents("a", listOf(event(1))) }.json()
        assertFalse(RoomHistoryCache(owner, good).isEmpty)
        for (bad in listOf("{", "[]", good.replace("\"version\":1", "\"version\":0"), JSONObject(good).put("owner", "x").toString(),
            JSONObject(good).put("timelines", "broken").toString(), "x".repeat(RoomHistoryCache.MAX_BYTES + 1))) {
            assertTrue(bad.take(40), RoomHistoryCache(owner, bad).isEmpty)
        }
        assertTrue(RoomHistoryCache("", good).isEmpty)
    }
}
