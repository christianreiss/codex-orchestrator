package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class ChatDomainTest {
    private fun portal(cursor: Long, type: String, payload: JSONObject) =
        JSONObject().put("cursor", cursor).put("type", type).put("created_at", "2026-10-11T15:00:00Z").put("payload", payload)

    private fun room(kind: String = "chat") = JSONObject()
        .put("id", "6f1c1d4e-8a63-4e7e-9d1b-0d8a3b6c2f10").put("created_at", "2026-10-11T15:02:00.000Z")
        .put("actor", "admin:3").put("name", "Chris").put("content", "Ship it?")
        .put("attachments", JSONArray(listOf("a1", "a2"))).put("kind", kind)

    @Test fun conversationKeysRoundTripTheExistingStorageKeys() {
        assertEquals("agent-1", ConversationKey.Direct("agent-1").storageKey)
        assertEquals("room:r-1", ConversationKey.Room("r-1").storageKey)
        assertEquals(ConversationKey.Room("r-1"), ConversationKey.fromStorageKey("room:r-1"))
        assertEquals(ConversationKey.Direct("agent-1"), ConversationKey.fromStorageKey("agent-1"))
        assertTrue(MessageKey.PortalEvent(-1).local)
        assertFalse(MessageKey.PortalEvent(4).local)
    }

    @Test fun portalUserMessageKeepsCursorReplyAttachmentsAndReceipt() {
        val event = portal(2, "user_message", JSONObject().put("text", "That looks good. Keep this version.")
            .put("message_id", "m-2").put("reply_to", 1).put("attachments", JSONArray(listOf("photo"))))
        val message = ChatMessage.fromPortalEvent(event, mapOf("m-2" to "read"))!!
        assertEquals(MessageKey.PortalEvent(2), message.key)
        assertEquals(ChatAuthor.Role.Operator, message.author.role)
        assertEquals("That looks good. Keep this version.", message.text)
        assertEquals(listOf("photo"), message.attachments)
        assertEquals(MessageKey.PortalEvent(1), message.replyTo)
        assertEquals(ChatItemKind.Message, message.kind)
        assertEquals("user_message", message.rawKind)
        assertEquals(Instant.parse("2026-10-11T15:00:00Z"), message.createdAt)
        assertEquals("m-2", message.messageId)
        assertEquals(listOf(ChatDelivery(null, "read")), message.deliveries)
    }

    @Test fun portalAssistantMessageWithoutReplyOrReceipt() {
        val message = ChatMessage.fromPortalEvent(portal(3, "assistant_message", JSONObject().put("text", "Done.")))!!
        assertEquals(ChatAuthor.Role.Agent, message.author.role)
        assertNull(message.replyTo)
        assertTrue(message.deliveries.isEmpty())
        assertTrue(message.attachments.isEmpty())
    }

    @Test fun localPendingBubbleMapsWithNegativeCursorAndLocalState() {
        val event = PendingChat("client", -1, "Hello", "{\"attachments\":[\"photo\"],\"reply_to\":7}", "2026-10-11T15:00:00Z", "unconfirmed").event()
        val message = ChatMessage.fromPortalEvent(event)!!
        assertEquals(MessageKey.PortalEvent(-1), message.key)
        assertTrue((message.key as MessageKey.PortalEvent).local)
        assertEquals("client", message.localId)
        assertEquals("client", message.messageId)
        assertEquals("unconfirmed", message.localStatus)
        assertEquals(MessageKey.PortalEvent(7), message.replyTo)
        assertEquals(listOf("photo"), message.attachments)
    }

    @Test fun portalNoticeMapsSeverityAndSummary() {
        val event = portal(5, "attention", JSONObject().put("severity", "blocker").put("summary", "Needs a token").put("notice_id", "n-1"))
        val message = ChatMessage.fromPortalEvent(event)!!
        assertEquals(ChatItemKind.Notice, message.kind)
        assertEquals("blocker", message.severity)
        assertEquals("n-1", message.noticeId)
        assertEquals("Needs a token", message.text)
    }

    @Test fun mapperAgreesWithConversationEventsOnHiddenItems() {
        val hidden = listOf(
            portal(6, "message_accepted", JSONObject().put("message_id", "m-2")),
            portal(7, "progress", JSONObject().put("text", "Working")),
            portal(8, "assistant_message", JSONObject().put("text", " ")),
            portal(9, "attention", JSONObject().put("summary", "No severity")),
        )
        hidden.forEach { assertNull(it.toString(), ChatMessage.fromPortalEvent(it)) }
        assertTrue(conversationEvents(hidden).isEmpty())
        val attachmentOnly = portal(10, "user_message", JSONObject().put("attachments", JSONArray(listOf("doc"))))
        assertEquals(conversationEvents(listOf(attachmentOnly)).size, listOfNotNull(ChatMessage.fromPortalEvent(attachmentOnly)).size)
        assertEquals("", ChatMessage.fromPortalEvent(attachmentOnly)!!.text)
    }

    @Test fun portalEventWithoutParsableTimeKeepsRawValue() {
        val event = portal(11, "assistant_message", JSONObject().put("text", "Hi")).put("created_at", "yesterday")
        val message = ChatMessage.fromPortalEvent(event)!!
        assertNull(message.createdAt)
        assertEquals("yesterday", message.createdAtRaw)
    }

    @Test fun roomChatEventMapsAuthorReplyAndDeliveries() {
        val event = room().put("reply_to", "1b0e8f0a-4c55-4d1f-9a0d-6a3d4f4c7e21")
            .put("deliveries", JSONArray(listOf(
                JSONObject().put("address_id", "addr-1").put("status", "completed"),
                JSONObject().put("address_id", "addr-2").put("status", "in_progress"),
            )))
        val message = ChatMessage.fromRoomEvent(event)
        assertEquals(MessageKey.RoomEvent("6f1c1d4e-8a63-4e7e-9d1b-0d8a3b6c2f10"), message.key)
        assertEquals(ChatAuthor(ChatAuthor.Role.Operator, "admin:3", "Chris"), message.author)
        assertEquals("Ship it?", message.text)
        assertEquals(listOf("a1", "a2"), message.attachments)
        assertEquals(MessageKey.RoomEvent("1b0e8f0a-4c55-4d1f-9a0d-6a3d4f4c7e21"), message.replyTo)
        assertEquals(ChatItemKind.Message, message.kind)
        assertEquals("chat", message.rawKind)
        assertEquals(Instant.parse("2026-10-11T15:02:00Z"), message.createdAt)
        assertEquals(listOf(ChatDelivery("addr-1", "completed"), ChatDelivery("addr-2", "in_progress")), message.deliveries)
        assertNull(message.messageId)
        assertNull(message.localStatus)
    }

    @Test fun roomEventOptionalFieldsAndKinds() {
        val agent = ChatMessage.fromRoomEvent(room("membership").put("actor", "agent:9").put("reply_to", JSONObject.NULL))
        assertEquals(ChatAuthor.Role.Agent, agent.author.role)
        assertEquals(ChatItemKind.Membership, agent.kind)
        assertNull(agent.replyTo)
        assertTrue(agent.deliveries.isEmpty())
        val unknown = ChatMessage.fromRoomEvent(room("workflow").put("actor", "server"))
        assertEquals(ChatAuthor.Role.Unknown, unknown.author.role)
        assertEquals(ChatItemKind.Other, unknown.kind)
        assertEquals("workflow", unknown.rawKind)
    }
}
