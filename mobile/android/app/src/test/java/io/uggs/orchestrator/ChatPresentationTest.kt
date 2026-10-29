package io.uggs.orchestrator

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class ChatPresentationTest {
    private val zone = ZoneId.of("Europe/Berlin")
    private fun message(cursor: Long, type: String, time: String?) = JSONObject()
        .put("cursor", cursor).put("type", type).put("created_at", time)
        .put("payload", JSONObject().put("text", "Message " + cursor))
    private fun bubbles(events: List<JSONObject>, notices: List<JSONObject> = emptyList()) =
        buildTimeline(portalTimelineEntries(events, notices), zone).filterIsInstance<TimelineItem.Bubble>()
    private fun messagesGrouped(first: JSONObject, second: JSONObject, @Suppress("UNUSED_PARAMETER") zone: ZoneId) =
        bubbles(listOf(first, second)).let { it.size == 2 && !it[1].startsGroup }

    @Test fun importantNoticesAppearBetweenMessagesWithoutLifecycleNoiseOrDuplicatePreviews() {
        val notice = JSONObject().put("id", "notice-id").put("severity", "important")
            .put("summary", "Review the result").put("since", "2026-10-07T10:01:00Z")
        val event = JSONObject().put("cursor", 2).put("type", "attention").put("created_at", notice.getString("since"))
            .put("payload", JSONObject().put("notice_id", "notice-id").put("severity", "important").put("summary", "Review the result"))
        val events = listOf(message(1, "assistant_message", "2026-10-07T10:00:00Z"), event,
            message(3, "receiver_ready", "2026-10-07T10:01:30Z"),
            message(4, "assistant_message", "2026-10-07T10:02:00Z"))
        val messages = bubbles(events, listOf(notice))
        assertEquals(listOf(1L, 2L, 4L), messages.map { it.source.getLong("cursor") })
        assertEquals("Review the result", messageText(messages[1].source))
        assertEquals("important", noticeSeverity(messages[1].source.optJSONObject("payload")))
        assertTrue(messages[0].endsGroup)
        assertEquals(ReplyPreview("Agent", "Review the result"), replyPreview(events, 2, "Agent"))

        val outsideTail = bubbles(listOf(events.first(), events.last()), listOf(notice, notice))
        assertEquals(listOf("message:1", "notice:notice-id", "message:4"), outsideTail.map { it.key })
        assertEquals(0, outsideTail[1].source.optLong("cursor"))
    }

    @Test fun importantRepliesAndQuestionsKeepTheirContentAndClassification() {
        val normal = message(1, "assistant_message", "2026-10-07T10:00:00Z")
        val important = message(2, "assistant_message", "2026-10-07T10:01:00Z").apply {
            getJSONObject("payload").put("severity", "critical").put("notice_id", "critical-id").put("summary", "Short reason")
        }
        val question = message(3, "waiting_input", "2026-10-07T10:02:00Z").put("payload",
            JSONObject().put("severity", "blocker").put("notice_id", "blocker-id").put("summary", "Choose a target"))
        assertEquals(3, conversationEvents(listOf(normal, important, question)).size)
        assertEquals("Message 2", messageText(important))
        assertEquals("Choose a target", messageText(question))
        assertFalse(messagesGrouped(normal, important, zone))
        question.getJSONObject("payload").remove("severity")
        assertEquals(listOf(normal, important), conversationEvents(listOf(normal, important, question)))
    }

    @Test fun groupingRequiresSameSenderWithinFiveMinutesOnTheSameLocalDay() {
        val first = message(1, "assistant_message", "2026-10-07T10:00:00Z")
        assertTrue(messagesGrouped(first, message(2, "assistant_message", "2026-10-07T10:05:00Z"), zone))
        assertFalse(messagesGrouped(first, message(2, "assistant_message", "2026-10-07T10:05:01Z"), zone))
        assertFalse(messagesGrouped(first, message(2, "user_message", "2026-10-07T10:01:00Z"), zone))
        assertFalse(messagesGrouped(first, message(2, "assistant_message", "2026-10-07T09:59:59Z"), zone))
        assertFalse(messagesGrouped(message(1, "user_message", "2026-10-07T21:59:59Z"), message(2, "user_message", "2026-10-07T22:00:00Z"), zone))
    }

    @Test fun legacyOrMalformedTimestampsNeverInventAClockOrAGroup() {
        val first = message(1, "assistant_message", null)
        val second = message(2, "assistant_message", "not-a-date")
        assertNull(eventTime(first)); assertNull(eventTime(second))
        assertFalse(messagesGrouped(first, second, zone))
        assertTrue(buildTimeline(portalTimelineEntries(listOf(first, second)), zone).all { it is TimelineItem.Bubble })
    }

    @Test fun transcriptKeepsCursorOrderAndAddsLocalDaysWithSystemNoiseCollapsed() {
        val events = listOf(
            message(1, "assistant_message", "2026-10-07T21:59:00Z"),
            message(2, "receiver_ready", "2026-10-07T21:59:10Z"),
            message(3, "assistant_message", "2026-10-07T21:59:30Z"),
            message(4, "user_message", "2026-10-07T22:00:00Z"),
        )
        val rows = buildTimeline(portalTimelineEntries(events), zone)
        assertEquals(listOf(LocalDate.parse("2026-10-07"), LocalDate.parse("2026-10-08")), rows.filterIsInstance<TimelineItem.Day>().map { it.date })
        val messages = rows.filterIsInstance<TimelineItem.Bubble>()
        assertEquals(listOf(1L, 3L, 4L), messages.map { it.source.getLong("cursor") })
        // The status row between two replies is visible, so it ends the first group.
        assertEquals(listOf("Message 2"), rows.filterIsInstance<TimelineItem.StatusRun>().flatMap { run -> run.lines.map { it.text } })
        assertTrue(messages.all { it.startsGroup && it.endsGroup })
    }

    @Test fun attachmentOnlyMessagesRemainVisibleWithoutTurningTransportEventsIntoMessages() {
        val attachment=JSONObject().put("cursor",9).put("type","assistant_message").put("payload",JSONObject().put("text","").put("attachments",org.json.JSONArray().put("file-id")))
        assertEquals(1,bubbles(listOf(attachment)).size)
        attachment.put("type","message_accepted")
        assertTrue(portalTimelineEntries(listOf(attachment)).isEmpty())
    }

    @Test fun replyPreviewUsesTheExactRetainedMessageAndHandlesMediaOrExpiredHistory() {
        val own = message(4, "user_message", null)
        val media = message(5, "assistant_message", null).put("payload", JSONObject().put("attachments", org.json.JSONArray().put("photo")))
        val events = listOf(own, media, message(6, "message_read", null))
        assertEquals(ReplyPreview("You", "Message 4"), replyPreview(events, 4, "Claudia"))
        assertEquals(ReplyPreview("Claudia", "Attachment"), replyPreview(events, 5, "Claudia"))
        assertEquals(ReplyPreview("Earlier message", "Message is no longer in this history"), replyPreview(events, 3, "Claudia"))
        assertEquals(ReplyPreview("Earlier message", "Message is no longer in this history"), replyPreview(events, 6, "Claudia"))
    }

    @Test fun changingClockDoesNotCreateDuplicateListKeys() {
        val rows = buildTimeline(portalTimelineEntries(listOf(
            message(1, "assistant_message", "2026-10-07T21:59:00Z"),
            message(2, "assistant_message", "2026-10-07T22:01:00Z"),
            message(3, "assistant_message", "2026-10-07T21:59:59Z"),
        )), zone)
        assertEquals(rows.size, rows.map { it.key }.toSet().size)
        assertEquals("Today", dayLabel(LocalDate.parse("2026-10-07"), LocalDate.parse("2026-10-07")))
        assertEquals("Yesterday", dayLabel(LocalDate.parse("2026-10-06"), LocalDate.parse("2026-10-07")))
    }
}
