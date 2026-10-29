package io.uggs.orchestrator

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Push payloads → notification model → action requests and outbox entries (R3 C1/C2). */
class NotificationModelTest {
    private val roomId = "6f0e1c2b-0000-4000-8000-0000000000aa"
    private val agentId = "1b4e28ba-2fa1-11d2-883f-0016d3cca427"
    private val promptId = "0d4c7a8e-1111-4222-8333-444455556666"
    private fun room(extra: Map<String, String> = emptyMap()) = mapOf(
        "notification_id" to "n-room", "device_id" to "phone", "kind" to "room", "target_id" to roomId, "room_id" to roomId,
        "event_id" to "ev-1", "conversation_key" to "room:$roomId", "room_title" to "Release", "sender_name" to "Builder",
        "engine" to "codex", "reason" to "mention", "summary" to "Builder mentioned you in Release", "ts" to "2026-10-29T10:00:00.123Z",
    ) + extra
    private fun agent(kind: String = "reply", extra: Map<String, String> = emptyMap()) = mapOf(
        "notification_id" to "n-agent", "device_id" to "phone", "kind" to kind, "target_id" to agentId, "event_cursor" to "42",
        "conversation_key" to "agent:$agentId", "agent_id" to agentId, "agent_name" to "Reviewer", "sender_name" to "Reviewer",
        "event_id" to "42", "summary" to "Done.", "ts" to "2026-10-29T10:00:00Z",
    ) + extra
    private val options = """[{"id":"yes","label":"Yes, ship"},{"id":"no","label":"No"},{"id":"later","label":"Later"},{"id":"skip","label":"Skip"}]"""

    @Test fun roomPushBecomesARoomConversation() {
        val push = parseConversationPush(room())!!
        assertEquals(ConversationKey.Room(roomId), push.key)
        assertTrue(push.room)
        assertEquals("Release", push.title)
        assertEquals("Builder", push.sender)
        assertEquals("Builder mentioned you in Release", push.summary)
        assertEquals("ev-1", push.eventId)
        assertEquals("2026-10-29T10:00:00.123Z", push.ts)
        assertEquals(1793268000123L, push.time!!.toEpochMilli())
        assertEquals(listOf(PushActionKind.Reply, PushActionKind.MarkRead), pushActions(push).map { it.kind })
        assertEquals("orchestrator://chat/room%3A$roomId", Routes.deepLink(push.key))
    }

    @Test fun agentKeysUseTheAgentPrefixAndOlderServersFallBackToTheTarget() {
        assertEquals(ConversationKey.Direct(agentId), parseConversationPush(agent())!!.key)
        val legacy = agent() - "conversation_key" - "agent_name" - "sender_name"
        val push = parseConversationPush(legacy)!!
        assertEquals(ConversationKey.Direct(agentId), push.key)
        assertNull(push.sender)
        assertEquals(42L, push.eventCursor)
        assertEquals(ConversationKey.Room(roomId), pushConversationKey(room() - "conversation_key"))
        assertEquals(ConversationKey.Room(roomId), pushConversationKey(mapOf("kind" to "room_read", "room_id" to roomId, "target_id" to roomId)))
    }

    @Test fun approvalsReadsAndMismatchedKindsAreNotConversationPushes() {
        assertNull(parseConversationPush(agent("approval")))
        assertNull(parseConversationPush(agent("read")))
        assertNull(parseConversationPush(mapOf("kind" to "room_read", "notification_id" to "x", "target_id" to roomId, "room_id" to roomId)))
        assertNull("a room push must name a room", parseConversationPush(room(mapOf("conversation_key" to "agent:$agentId"))))
        assertNull(parseConversationPush(room() - "notification_id"))
    }

    @Test fun promptOptionsAreBoundedAndMalformedOnesSkipped() {
        assertEquals(listOf("yes", "no", "later", "skip"), parsePromptOptions(options).map { it.id })
        val many = (1..9).joinToString(",", "[", "]") { """{"id":"o$it","label":"Option $it"}""" }
        assertEquals(6, parsePromptOptions(many).size)
        assertEquals(listOf(PromptOption("ok", "Fine")), parsePromptOptions("""[{"id":"ok","label":"  Fine "},{"id":"","label":"x"},{"label":"y"},"z",{"id":"ok","label":"dup"}]"""))
        assertEquals(60, parsePromptOptions("""[{"id":"long","label":"${"a".repeat(90)}"}]""").single().label.length)
        assertTrue(parsePromptOptions("not json").isEmpty())
        assertTrue(parsePromptOptions(null).isEmpty())
    }

    @Test fun questionsShowAtMostThreeAnswerButtonsThenReplyAndMarkRead() {
        val question = parseConversationPush(agent("attention", mapOf("prompt_id" to promptId, "options" to options)))!!
        assertEquals(List(3) { PushActionKind.Answer }, pushActions(question).map { it.kind })
        assertEquals(listOf("yes", "no", "later"), pushActions(question).map { it.option!!.id })
        val one = parseConversationPush(agent("attention", mapOf("prompt_id" to promptId, "options" to """[{"id":"go","label":"Go"}]""")))!!
        assertEquals(listOf(PushActionKind.Answer, PushActionKind.Reply, PushActionKind.MarkRead), pushActions(one).map { it.kind })
        val text = parseConversationPush(agent("attention", mapOf("prompt_id" to promptId, "answer_mode" to "text", "options" to options)))!!
        assertEquals("text answers get no buttons", listOf(PushActionKind.Reply, PushActionKind.MarkRead), pushActions(text).map { it.kind })
        val noPrompt = parseConversationPush(agent("attention", mapOf("options" to options)))!!
        assertTrue("options without a prompt cannot be answered", noPrompt.options.isEmpty())
        val roomWithPrompt = parseConversationPush(room(mapOf("prompt_id" to promptId, "options" to options)))!!
        assertNull(roomWithPrompt.promptId)
    }

    @Test fun answerButtonsAnswerThePromptWithChoiceValueAndNoVersion() {
        val push = parseConversationPush(agent("attention", mapOf("prompt_id" to promptId, "options" to options)))!!
        val entry = notificationAnswerEntry(push, push.options[1], "2026-10-29T10:01:00Z")!!
        assertEquals("/agents/$agentId/prompts/$promptId/answer", entry.path)
        assertEquals(agentId, entry.conversation)
        val body = JSONObject(entry.body)
        assertEquals(entry.id, body.getString("client_message_id"))
        assertEquals("no", body.getString("answer"))
        assertEquals("no", body.getJSONObject("metadata").getString("choice_value"))
        assertFalse(body.has("version"))
        assertFalse(body.has("content"))
        assertEquals("a repeated tap answers with the same id", entry.id, notificationAnswerEntry(push, push.options[0], "later")!!.id)
        val restored = chatSendFromOutbox(entry)!!
        assertEquals("no", restored.text)
        assertNull(restored.version)
        assertNull(notificationAnswerEntry(parseConversationPush(room())!!, push.options[0], "x"))
    }

    @Test fun typedRepliesGoThroughTheMatchingRouteWithStableIds() {
        val roomPush = parseConversationPush(room())!!
        val roomEntry = notificationReplyEntry(roomPush, "  On it ", "2026-10-29T10:01:00Z")!!
        assertEquals("/rooms/send", roomEntry.path)
        assertEquals("room:$roomId", roomEntry.conversation)
        assertTrue(roomEntry.room)
        val roomBody = JSONObject(roomEntry.body)
        assertEquals(roomId, roomBody.getString("room_id"))
        assertEquals(roomEntry.id, roomBody.getString("client_request_id"))
        assertEquals("On it", roomBody.getString("content"))
        assertEquals("ev-1", roomBody.getString("reply_to"))
        assertFalse("a notification reply shares without asking", roomBody.has("ask_all") || roomBody.has("recipients"))
        assertEquals(roomEntry.id, notificationReplyEntry(roomPush, "On it", "later")!!.id)
        assertNotEquals(roomEntry.id, notificationReplyEntry(roomPush, "Other text", "later")!!.id)
        assertNull(notificationReplyEntry(roomPush, "   ", "x"))

        val direct = notificationReplyEntry(parseConversationPush(agent())!!, "Thanks", "2026-10-29T10:01:00Z")!!
        assertEquals("/agents/$agentId/messages", direct.path)
        assertEquals("Thanks", JSONObject(direct.body).getString("content"))
        assertEquals("Thanks", chatSendFromOutbox(direct)!!.text)
        val answer = notificationReplyEntry(parseConversationPush(agent("attention", mapOf("prompt_id" to promptId)))!!, "Use main", "x")!!
        assertEquals("/agents/$agentId/prompts/$promptId/answer", answer.path)
        assertEquals("Use main", JSONObject(answer.body).getString("answer"))
        assertNotEquals("different notifications never collide", direct.id, notificationReplyEntry(parseConversationPush(agent() + ("notification_id" to "other"))!!, "Thanks", "x")!!.id)
    }

    @Test fun actionRequestsRoundTripThroughIntentExtras() {
        val push = parseConversationPush(agent("attention", mapOf("prompt_id" to promptId, "options" to options)))!!
        val request = NotificationActionRequest(PushActionKind.Answer, "scope", null, 77, push, push.options[2])
        val parsed = NotificationActionRequest.parse(request.extras())!!
        assertEquals(PushActionKind.Answer, parsed.action)
        assertEquals("scope", parsed.scope)
        assertNull(parsed.tag)
        assertEquals(77, parsed.id)
        assertEquals(push.key, parsed.push.key)
        assertEquals(promptId, parsed.push.promptId)
        assertEquals(42L, parsed.push.eventCursor)
        assertEquals(PromptOption("later", "Later"), parsed.option)
        // The rebuilt push produces the same frozen request as the original.
        assertEquals(notificationAnswerEntry(push, push.options[2], "t"), notificationAnswerEntry(parsed.push, parsed.option!!, "t"))

        val roomPush = parseConversationPush(room())!!
        val markRead = NotificationActionRequest.parse(NotificationActionRequest(PushActionKind.MarkRead, "scope", "room:scope:$roomId", ROOM_NOTIFICATION_ID, roomPush).extras())!!
        assertEquals("room:scope:$roomId", markRead.tag)
        assertEquals("2026-10-29T10:00:00.123Z", markRead.push.ts)
        assertEquals(notificationReplyEntry(roomPush, "Yes", "t"), notificationReplyEntry(markRead.push, "Yes", "t"))

        assertNull("an answer needs its option", NotificationActionRequest.parse(request.extras() - "option_id"))
        assertNull(NotificationActionRequest.parse(request.extras() + ("action" to "Delete")))
        assertNull(NotificationActionRequest.parse(request.extras() + ("kind" to "room")))
        assertNull(NotificationActionRequest.parse(emptyMap()))
    }

    @Test fun roomNotificationHistoryKeepsTheNewestLinesInOrder() {
        var history = emptyList<NotificationLine>()
        (1..8).forEach { history = appendNotificationLine(history, NotificationLine("Agent $it", "Message $it", it * 1000L)) }
        assertEquals(ROOM_NOTIFICATION_HISTORY, history.size)
        assertEquals("Message 3", history.first().text)
        history = appendNotificationLine(history, NotificationLine("Late", "Out of order", 2_500L))
        assertEquals("an older line sorts in and drops out", "Message 3", history.first().text)
        assertEquals("Message 8", history.last().text)
    }
}
