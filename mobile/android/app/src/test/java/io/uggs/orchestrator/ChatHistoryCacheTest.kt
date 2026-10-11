package io.uggs.orchestrator

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ChatHistoryCacheTest {
    private val connection = Connection("https://fleet.example", "private-token", "phone", null)
    private val owner = ChatHistoryCache.owner(connection)
    private fun agent(id: String = "chat") = JSONObject().put("id", id).put("presence", "working")
        .put("relay_ready", true).put("session_name", "Review")
    private fun event(cursor: Long, text: String = "Reply $cursor") = JSONObject().put("cursor", cursor)
        .put("type", "assistant_message").put("payload", JSONObject().put("text", text))

    @Test fun restoresConfirmedHistoryWithoutLivePermissionsOrUnreadState() {
        val cache = ChatHistoryCache(owner)
        cache.remember(agent().put("pending_prompt", JSONObject().put("id", "question"))
            .put("reply_cursor", 9).put("unread_reply_count", 4), listOf(event(-1, "Pending send"), event(9)))
        val restored = ChatHistoryCache(owner, cache.json())
        assertEquals(listOf(9L), restored.events("chat").map { it.getLong("cursor") })
        val row = restored.agents().single()
        assertFalse(isReachable(row))
        assertTrue(isOnlineActiveAgent(row))
        assertEquals("unknown", nativeActivity(row, System.currentTimeMillis()))
        assertFalse(row.has("pending_prompt"))
        assertFalse(row.has("unread_reply_count"))
        assertFalse(cache.json().contains(connection.token))
    }

    @Test fun serverReplaysReplaceCachedRowsAndNewEventsAreOrderedOnce() {
        val merged = mergeChatEvents(listOf(event(9, "Cached"), event(7)), listOf(event(9, "Server"), event(11), event(11)))
        assertEquals(listOf(7L, 9L, 11L), merged.map { it.getLong("cursor") })
        assertEquals("Server", merged[1].getJSONObject("payload").getString("text"))
    }

    @Test fun refusesOtherServersDevicesAndPairingsAndRecoversFromCorruptFiles() {
        val cache = ChatHistoryCache(owner).apply { remember(agent(), listOf(event(1))) }
        for (other in listOf(connection.copy(server = "https://other.example"), connection.copy(deviceId = "other"), connection.copy(token = "new-token"))) {
            assertTrue(ChatHistoryCache(ChatHistoryCache.owner(other), cache.json()).agents().isEmpty())
        }
        assertTrue(ChatHistoryCache(owner, "broken").agents().isEmpty())
        assertTrue(ChatHistoryCache(owner, "{\"version\":999}").agents().isEmpty())
        cache.clear()
        assertTrue(ChatHistoryCache(owner, cache.json()).events("chat").isEmpty())
    }

    @Test fun authoritativeSnapshotEvictsMissingEndedAndReadOnlyChatsButKeepsUnfinishedOfflineOnes() {
        val cache = ChatHistoryCache(owner)
        for (id in listOf("ended", "closed", "readonly", "missing", "offline")) cache.remember(agent(id), listOf(event(1)))
        cache.reconcile(listOf(agent("ended").put("presence", "ended"),
            agent("closed").put("daemon_session", true).put("remote_status", "closed"),
            agent("readonly").put("read_only", true), agent("offline").put("presence", "offline")))
        assertEquals(listOf("offline"), cache.agents().map { it.getString("id") })
        assertEquals(1, cache.events("offline").size)
    }

    @Test fun boundsConversationCountEventsAndDiskSize() {
        val cache = ChatHistoryCache(owner)
        val events = (1L..600L).map { event(it) }
        for (i in 1..25) cache.remember(agent("chat-$i"), events)
        assertEquals(ChatHistoryCache.MAX_CHATS, cache.agents().size)
        assertTrue(cache.events("chat-1").isEmpty())
        assertEquals(500, cache.events("chat-25").size)
        val large = ChatHistoryCache(owner)
        large.remember(agent(), (1L..200L).map { event(it, "x".repeat(32768)) })
        assertTrue(large.json().toByteArray(Charsets.UTF_8).size <= ChatHistoryCache.MAX_BYTES)
        assertEquals(200L, large.events("chat").last().getLong("cursor"))
    }
    @Test fun progressDoesNotEvictChatTextAndItsCursorStillPreventsRepeatedDownloads() {
        val cache = ChatHistoryCache(owner)
        cache.remember(agent(), listOf(event(1)) + (2L..1000L).map { event(it).put("type", "progress") })
        val restored = ChatHistoryCache(owner, cache.json())
        assertEquals(listOf(1L), restored.events("chat").map { it.getLong("cursor") })
        assertEquals(1000L, restored.cursor("chat"))
        restored.remember(agent(), mergeChatEvents(restored.events("chat"), listOf(event(1001))), 1001)
        assertEquals(listOf(1L, 1001L), restored.events("chat").map { it.getLong("cursor") })
        restored.remember(agent(), emptyList())
        assertTrue(restored.events("chat").isEmpty())
    }
}
