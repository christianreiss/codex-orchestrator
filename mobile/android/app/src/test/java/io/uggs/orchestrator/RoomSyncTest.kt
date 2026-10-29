package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

/** Pure R3 rules: delta merge, history cursor, activity TTL, own actor, protocol fallback, frames. */
class RoomSyncTest {
    private fun event(id: String, second: Int, content: String = "m$id", deliveries: JSONArray? = null) = JSONObject().put("id", id).put("kind", "chat")
        .put("content", content).put("actor", "agent:a").put("created_at", "2026-10-29T10:00:%02d.000Z".format(second))
        .apply { deliveries?.let { put("deliveries", it) } }
    private fun ids(events: List<JSONObject>) = events.map { it.getString("id") }

    @Test fun deltaMergeAddsNewEventsReplacesReceiptsAndDropsDuplicates() {
        val old = listOf(event("a", 1), event("b", 2, deliveries = JSONArray().put(JSONObject().put("address_id", "x").put("status", "queued"))))
        val receipt = event("b", 2, deliveries = JSONArray().put(JSONObject().put("address_id", "x").put("status", "completed")))
        val merged = mergeRoomDelta(old, listOf(event("c", 3), receipt, event("c", 3)), hasEarlier = true)
        assertEquals(listOf("a", "b", "c"), ids(merged))
        assertEquals("completed", merged[1].getJSONArray("deliveries").getJSONObject(0).getString("status"))
    }

    @Test fun outOfOrderDeltaEventsSortInButNeverOpenAGapBeforeTheLoadedHistory() {
        val old = listOf(event("b", 10), event("d", 30))
        // "c" arrived late (older created_at than "d"); "a" predates everything loaded.
        val merged = mergeRoomDelta(old, listOf(event("e", 40), event("c", 20), event("a", 5)), hasEarlier = true)
        assertEquals(listOf("b", "c", "d", "e"), ids(merged))
        assertEquals("a complete room keeps older events too", listOf("a", "b", "c", "d", "e"),
            ids(mergeRoomDelta(old, listOf(event("e", 40), event("c", 20), event("a", 5)), hasEarlier = false)))
        assertEquals(listOf("a"), ids(mergeRoomDelta(emptyList(), listOf(event("a", 5)), hasEarlier = true)))
        assertEquals("equal times order by id", listOf("x1", "x2"), ids(mergeRoomDelta(listOf(event("x2", 9)), listOf(event("x1", 9)), hasEarlier = false)))
    }

    @Test fun historyCursorMatchesTheServerFormat() {
        val cursor = roomHistoryCursor(event("e1", 7))
        assertFalse(cursor.contains("=") || cursor.contains("+") || cursor.contains("/"))
        val decoded = JSONObject(String(Base64.getUrlDecoder().decode(cursor), Charsets.UTF_8))
        assertEquals("2026-10-29T10:00:07.000Z", decoded.getString("time"))
        assertEquals("e1", decoded.getString("id"))
    }

    @Test fun activityExpiresAfterItsTtlAndClearsOnEmptyOrZero() {
        val builder = RoomActivityActor("addr-1", "Builder", "working")
        var state = applyRoomActivity(emptyMap(), "room", listOf(builder), 8, now = 1_000)
        assertEquals(listOf(builder), activeRoomActors(state, "room", 8_999))
        assertTrue("expired without renewal", activeRoomActors(state, "room", 9_000).isEmpty())
        state = applyRoomActivity(state, "room", listOf(builder), 8, now = 5_000)
        assertEquals("a renewal extends it", listOf(builder), activeRoomActors(state, "room", 12_000))
        assertTrue(activeRoomActors(applyRoomActivity(state, "room", emptyList(), 8, 6_000), "room", 6_001).isEmpty())
        assertTrue(activeRoomActors(applyRoomActivity(state, "room", listOf(builder), 0, 6_000), "room", 6_001).isEmpty())
        val other = applyRoomActivity(state, "other", listOf(builder), 8, 20_000)
        assertFalse("applying prunes expired rooms", "room" in other)
        assertTrue(activeRoomActors(other, "missing", 20_000).isEmpty())
        assertEquals("a huge TTL is capped", 1_000 + 60_000L, applyRoomActivity(emptyMap(), "r", listOf(builder), 9_999, 1_000).getValue("r").expiresAt)
    }

    @Test fun ownMessagesFollowTheMeActorWithTheOldRuleAsFallback() {
        assertTrue(isOwnRoomActor("admin:7", "admin:7"))
        assertFalse("another admin is not me", isOwnRoomActor("admin:8", "admin:7"))
        assertTrue("an unconfirmed local send is always mine", isOwnRoomActor("admin:local", "admin:7"))
        assertFalse(isOwnRoomActor("agent:a", "admin:7"))
        assertTrue("older server: any admin", isOwnRoomActor("admin:8", null))
        assertFalse(isOwnRoomActor(null, null))
        val events = listOf(event("a", 1).put("actor", "admin:7"), event("b", 2).put("actor", "admin:8"))
        val own = roomTimelineEntries(TestTexts, events, "admin:7").map { (it as TimelineEntry.Message).own }
        assertEquals(listOf(true, false), own)
        assertEquals(listOf(true, true), roomTimelineEntries(TestTexts, events).map { (it as TimelineEntry.Message).own })
    }

    @Test fun protocolFlagsDefaultOffForOlderServers() {
        assertEquals(RoomProtocols(), RoomProtocols.from(JSONObject().put("read_sync_protocol", 1)))
        val current = RoomProtocols.from(JSONObject().put("room_delta_protocol", 1).put("room_notifications_protocol", 1).put("actor", "admin:3"))
        assertEquals(RoomProtocols(delta = true, notifications = true, actor = "admin:3"), current)
        assertFalse("an unknown future version is not assumed compatible", RoomProtocols.from(JSONObject().put("room_delta_protocol", 2)).delta)
        assertNull(RoomProtocols.from(JSONObject().put("actor", "agent:x")).actor)
        assertNull(RoomProtocols.from(JSONObject().put("actor", JSONObject.NULL)).actor)
    }

    @Test fun roomActivityFramesParseAndBadOnesAreIgnored() {
        val frame = parseLiveFrame("""{"type":"room_activity","room_id":"r1","actors":[{"address_id":"a1","name":"Builder","state":"working"},{"address_id":"a1","name":"dup"},{"name":"no id"}],"ttl_s":8,"ts":"x"}""")
        assertEquals(LiveFrame.RoomActivity("r1", listOf(RoomActivityActor("a1", "Builder", "working")), 8), frame)
        assertEquals(LiveFrame.RoomActivity("r1", emptyList(), 0), parseLiveFrame("""{"type":"room_activity","room_id":"r1","actors":[],"ttl_s":0}"""))
        assertEquals(LiveFrame.RoomActivity("r1", emptyList(), 8), parseLiveFrame("""{"type":"room_activity","room_id":"r1","actors":["bad"],"ttl_s":8}"""))
        assertNull(parseLiveFrame("""{"type":"room_activity","actors":[]}"""))
        assertEquals(LiveFrame.Changed(setOf("rooms")), parseLiveFrame("""{"type":"changed","scopes":["rooms"]}"""))
    }

    @Test fun cacheKeepsDeltaCursorsBesideTheirTimelines() {
        val owner = ChatHistoryCache.owner(Connection("https://fleet.example", "t", "phone", null))
        val cache = RoomHistoryCache(owner)
        cache.rememberEvents("a", listOf(event("e1", 1)), after = 41, hasEarlier = true)
        cache.rememberEvents("b", listOf(event("e2", 2)), after = 7)
        cache.rememberEvents("c", (1..120).map { event("c$it", it % 60) }, after = 9)
        cache.changesAfter = 99
        val restored = RoomHistoryCache(owner, cache.json())
        assertEquals(41L, restored.after("a")); assertTrue(restored.hasEarlier("a"))
        assertEquals(7L, restored.after("b")); assertFalse(restored.hasEarlier("b"))
        assertEquals("a cut tail has earlier history", true, restored.hasEarlier("c"))
        assertEquals(99L, restored.changesAfter)
        restored.forget("a")
        assertNull(restored.after("a"))
        restored.stripContent()
        assertNull(restored.after("b")); assertEquals("the directory cursor stays", 99L, restored.changesAfter)
        restored.clear(); assertNull(restored.changesAfter)
        // A cache written before delta sync loads without cursors.
        val legacy = JSONObject(cache.json()).apply { remove("changes_after"); getJSONArray("timelines").getJSONObject(0).remove("after") }
        val old = RoomHistoryCache(owner, legacy.toString())
        assertNull(old.changesAfter)
        assertEquals(listOf("e1"), old.events("a").map { it.getString("id") })
        assertNull(old.after("a"))
    }
}
