package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class ChatAvatarsTest {
    @Test fun initialsAreTheShortestUniquePrefixUpToThreeLetters() {
        assertEquals(mapOf("1" to "L", "2" to "C"), memberInitials(mapOf("1" to "Liliana", "2" to "Claudia")))
        assertEquals(mapOf("1" to "Cla", "2" to "Cle", "3" to "T"), memberInitials(mapOf("1" to "Claudia", "2" to "Clemens", "3" to "Tanja")))
        assertEquals(mapOf("1" to "Al", "2" to "Ali"), memberInitials(mapOf("1" to "Al", "2" to "Alice")))
        assertEquals(mapOf("1" to "Ann", "2" to "Ann"), memberInitials(mapOf("1" to "Anna", "2" to "Anna")))
        assertEquals("R2", memberInitials(mapOf("1" to "(r2-d2)", "2" to "R5")).getValue("1"))
        assertEquals("?", memberInitials(mapOf("1" to "…")).getValue("1"))
    }

    @Test fun frozenInitialsKeepExistingMembersWhenSomeoneJoins() {
        val first = freezeInitials(emptyMap(), mapOf("1" to "Claudia", "2" to "Tanja"))
        assertEquals(mapOf("1" to "C", "2" to "T"), first)
        val joined = freezeInitials(first, mapOf("1" to "Claudia", "2" to "Tanja", "3" to "Clemens"))
        assertEquals("C", joined["1"])
        assertEquals("Cle", joined["3"])
        val left = freezeInitials(joined, mapOf("3" to "Clemens"))
        assertEquals(mapOf("3" to "Cle"), left)
    }

    @Test fun avatarColoursAreStableAndKeepWhiteInitialsAccessible() {
        val ids = (0 until 300).map { UUID.nameUUIDFromBytes("agent-$it".toByteArray()).toString() }
        ids.forEach { id ->
            assertEquals(avatarColorArgb(id), avatarColorArgb(id.uppercase()))
            assertTrue("contrast for $id", contrastRatio(avatarColorArgb(id), 0xFFFFFFFF.toInt()) >= 4.5)
        }
        assertTrue("hues spread", ids.map(::avatarColorArgb).toSet().size > 100)
        assertEquals(21.0, contrastRatio(0xFF000000.toInt(), 0xFFFFFFFF.toInt()), 0.01)
    }

    @Test fun recipientSelectionBuildsTheStrictSendBody() {
        val share = roomSendBody("room", "req", "Hi", listOf("att"), RoomRecipients.Share, null)
        assertFalse(share.has("ask_all")); assertFalse(share.has("recipients")); assertFalse(share.has("reply_to"))
        assertEquals("Hi", share.getString("content")); assertEquals("att", share.getJSONArray("attachments").getString(0))
        val all = roomSendBody("room", "req", "Hi", emptyList(), RoomRecipients.AskAll, "event-1")
        assertTrue(all.getBoolean("ask_all")); assertFalse(all.has("recipients")); assertEquals("event-1", all.getString("reply_to"))
        val members = roomSendBody("room", "req", "Hi", emptyList(), RoomRecipients.Share.toggle("b").toggle("a"), " ")
        assertEquals(listOf("a", "b"), (0 until 2).map { members.getJSONArray("recipients").getString(it) })
        assertFalse(members.has("ask_all")); assertFalse(members.has("reply_to"))
        assertEquals(RoomRecipients.Share, RoomRecipients.Members(setOf("a")).toggle("a"))
        assertEquals(setOf("room_id", "client_request_id", "content", "attachments", "recipients"), members.keys().asSequence().toSet())
    }

    @Test fun recipientsWhoCanNoLongerAnswerAreDropped() {
        fun member(id: String, reachable: Boolean, capable: Boolean = true) = JSONObject().put("id", id).put("reachable", reachable).put("chat_capable", capable)
        val roster = listOf(member("a", true), member("b", false), member("c", true, false))
        assertEquals(RoomRecipients.Members(setOf("a")), RoomRecipients.Members(setOf("a", "b", "c", "gone")).forMembers(roster))
        assertEquals(RoomRecipients.Share, RoomRecipients.Members(setOf("b")).forMembers(roster))
        assertEquals(RoomRecipients.AskAll, RoomRecipients.AskAll.forMembers(roster))
        assertTrue(JSONArray().length() == 0)
    }

    @Test fun recentChatsAreTheRetainedOnesThatAreNoLongerLive() {
        val live = JSONObject().put("id", "live").put("presence", "listening").put("last_event_at", "2026-10-07T10:00:00Z")
        val offline = JSONObject().put("id", "off").put("presence", "offline").put("last_event_at", "2026-10-07T09:00:00Z")
        val ended = JSONObject().put("id", "end").put("presence", "ended").put("last_event_at", "2026-10-07T11:00:00Z")
        assertEquals(listOf("end", "off"), recentChats(listOf(live, offline, ended)).map { it.getString("id") })
    }
}
