package io.uggs.orchestrator

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PendingChatTest {
    private val pending = PendingChat("client", -1, "Hello", "{\"attachments\":[\"photo\"],\"reply_to\":7}", "2026-10-11T15:00:00Z")

    @Test fun outgoingMessageExistsBeforeAnyServerResponseAndKeepsItsMedia() {
        val event = pending.event()
        assertEquals("Hello", event.getJSONObject("payload").getString("text"))
        assertEquals("photo", event.getJSONObject("payload").getJSONArray("attachments").getString(0))
        assertEquals(7, event.getJSONObject("payload").getInt("reply_to"))
        assertEquals("Sending…", deliveryLabel(TestTexts, event, emptyMap(), null, false))
        assertEquals(1, buildTimeline(portalTimelineEntries(TestTexts, listOf(event))).filterIsInstance<TimelineItem.Bubble>().size)
        assertEquals("Not confirmed", deliveryLabel(TestTexts, pending.copy(status = "unconfirmed").event(), emptyMap(), null, false))
        assertEquals("Queued", deliveryLabel(TestTexts, pending.copy(status = "queued", messageId = "server").event(), emptyMap(), null, false))
    }

    @Test fun reconciliationUsesConfirmedMessageIdentityNeverTextOrReceiptAlone() {
        val other = JSONObject().put("cursor", 10).put("type", "user_message")
            .put("payload", JSONObject().put("message_id", "other").put("text", "Hello"))
        val accepted = pending.copy(status = "queued", messageId = "server")
        assertEquals(listOf(accepted), pendingChatsAfterRefresh(listOf(accepted), listOf(other)))
        other.getJSONObject("payload").put("message_id", "server")
        assertTrue(pendingChatsAfterRefresh(listOf(accepted), listOf(other)).isEmpty())
        assertEquals(listOf(pending), pendingChatsAfterRefresh(listOf(pending), listOf(other)))
        other.put("type", "message_accepted")
        assertEquals(listOf(accepted), pendingChatsAfterRefresh(listOf(accepted), listOf(other)))
        assertEquals("Delivered to agent", deliveryLabel(TestTexts, accepted.event(), deliveryIndex(listOf(other)), null, false))
    }
}
