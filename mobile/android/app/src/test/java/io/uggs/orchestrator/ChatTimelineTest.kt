package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class ChatTimelineTest {
    private val zone = ZoneId.of("Europe/Berlin")
    private fun portal(cursor: Long, type: String, time: String, text: String = "Message $cursor", extra: JSONObject.() -> Unit = {}) = JSONObject()
        .put("cursor", cursor).put("type", type).put("created_at", time)
        .put("payload", JSONObject().put("text", text).apply(extra))
    private fun room(id: String, actor: String?, time: String, content: String = "Hello $id", kind: String? = "chat") = JSONObject()
        .put("id", id).put("created_at", time).put("content", content).put("name", actor?.substringAfter(':') ?: "Liliana")
        .apply { actor?.let { put("actor", it) }; kind?.let { put("kind", it) } }

    @Test fun consecutiveBubblesFromOneSpeakerGroupWithinFiveMinutesOnTheSameDay() {
        val items = buildTimeline(portalTimelineEntries(listOf(
            portal(1, "assistant_message", "2026-10-07T10:00:00Z"),
            portal(2, "assistant_message", "2026-10-07T10:05:00Z"),
            portal(3, "assistant_message", "2026-10-07T10:10:01Z"),
            portal(4, "user_message", "2026-10-07T10:10:30Z"),
        )), zone).filterIsInstance<TimelineItem.Bubble>()
        assertEquals(listOf(true, false, true, true), items.map { it.startsGroup })
        assertEquals(listOf(false, true, true, true), items.map { it.endsGroup })
        assertEquals(listOf(false, false, false, true), items.map { it.own })
        assertEquals(listOf("message:1", "message:2", "message:3", "message:4"), items.map { it.key })
    }

    @Test fun daySeparatorsFollowTheLocalDateAndBreakGroups() {
        // 21:59:59Z and 22:00:00Z straddle midnight in Berlin (CEST, UTC+2).
        val items = buildTimeline(portalTimelineEntries(listOf(
            portal(1, "user_message", "2026-10-07T21:59:59Z"),
            portal(2, "user_message", "2026-10-07T22:00:00Z"),
        )), zone)
        assertEquals(listOf(LocalDate.parse("2026-10-07"), LocalDate.parse("2026-10-08")), items.filterIsInstance<TimelineItem.Day>().map { it.date })
        assertTrue(items[0] is TimelineItem.Day && items[2] is TimelineItem.Day)
        assertTrue(items.filterIsInstance<TimelineItem.Bubble>().all { it.startsGroup && it.endsGroup })
    }

    @Test fun statusEventsAlwaysCollapseIntoOneRunAndReceiptsNeverShow() {
        val events = listOf(
            portal(1, "assistant_message", "2026-10-07T10:00:00Z"),
            portal(2, "progress", "2026-10-07T10:00:10Z", "INTERNAL_LIFECYCLE"),
            portal(3, "message_read", "2026-10-07T10:00:11Z", "") { put("message_id", "m") },
            portal(4, "tool_call", "2026-10-07T10:00:12Z", "Running tests"),
            portal(5, "progress", "2026-10-07T10:00:13Z", "Still running"),
            portal(6, "assistant_message", "2026-10-07T10:01:00Z"),
            portal(7, "progress", "2026-10-07T10:01:10Z", "Tail"),
        )
        val items = buildTimeline(portalTimelineEntries(events), zone)
        val runs = items.filterIsInstance<TimelineItem.StatusRun>()
        assertEquals(listOf(3, 1), runs.map { it.lines.size })
        assertEquals(listOf("INTERNAL_LIFECYCLE", "Running tests", "Still running"), runs[0].lines.map { it.text })
        // Status rows break bubble groups: both replies start and end their own group.
        assertTrue(items.filterIsInstance<TimelineItem.Bubble>().all { it.startsGroup && it.endsGroup })
        assertTrue(items.last() is TimelineItem.StatusRun)
    }

    @Test fun lifecycleEventsAreMarkersAndDeliveryFailuresStayReceipts() {
        val items = buildTimeline(portalTimelineEntries(listOf(
            portal(1, "started", "2026-10-07T10:00:00Z", ""),
            portal(2, "failed", "2026-10-07T10:00:01Z", "") { put("message_id", "m1") },
            portal(3, "completed", "2026-10-07T10:00:02Z", "") { put("summary", "All done") },
        )), zone).filterIsInstance<TimelineItem.Lifecycle>()
        assertEquals(listOf("Session started", "All done"), items.map { it.line.text })
        assertEquals(StatusLine.Tone.Success, items[1].line.tone)
    }

    @Test fun earlierQuestionsStayInHistoryButTheCurrentOneIsNotDuplicated() {
        val prompt = JSONObject().put("id", "q2").put("version", 1)
        val events = listOf(
            portal(1, "waiting_input", "2026-10-07T10:00:00Z", "") { put("question", "Which target?").put("prompt_id", "q1").put("options", JSONArray().put("A")) },
            portal(2, "waiting_input", "2026-10-07T10:01:00Z", "") { put("question", "Deploy now?").put("prompt_id", "q2").put("prompt_version", 1) },
        )
        val decisions = buildTimeline(portalTimelineEntries(events, prompt = prompt), zone).filterIsInstance<TimelineItem.Decision>()
        assertEquals(listOf("Which target?"), decisions.map { it.prompt.getString("question") })
        assertEquals(2, buildTimeline(portalTimelineEntries(events), zone).filterIsInstance<TimelineItem.Decision>().size)
    }

    @Test fun omittedNoticesAreInsertedOnceByTimeWithANoticeKey() {
        val notice = JSONObject().put("id", "n1").put("severity", "important").put("summary", "Review").put("since", "2026-10-07T10:01:00Z")
        val events = listOf(portal(1, "assistant_message", "2026-10-07T10:00:00Z"), portal(2, "assistant_message", "2026-10-07T10:02:00Z"))
        val bubbles = buildTimeline(portalTimelineEntries(events, listOf(notice, notice)), zone).filterIsInstance<TimelineItem.Bubble>()
        assertEquals(listOf("message:1", "notice:n1", "message:2"), bubbles.map { it.key })
        assertEquals(MessageKey.Notice("n1"), bubbles[1].message.key)
        assertEquals("important", bubbles[1].message.severity)
        // A retained notice event wins over the preview.
        val retained = portal(3, "attention", "2026-10-07T10:01:00Z", "") { put("notice_id", "n1").put("severity", "important").put("summary", "Review") }
        assertEquals(1, portalTimelineEntries(events + retained, listOf(notice)).count { (it as? TimelineEntry.Message)?.message?.noticeId == "n1" })
    }

    @Test fun roomEventsMapOneToOneAndGroupByActor() {
        val events = listOf(
            room("a", "agent:x", "2026-10-07T10:00:00Z"),
            room("b", "agent:x", "2026-10-07T10:01:00Z"),
            room("c", "agent:y", "2026-10-07T10:02:00Z"),
            room("d", null, "2026-10-07T10:03:00Z", "Joined", "membership"),
            room("e", "admin:1", "2026-10-07T10:04:00Z"),
            room("f", null, "2026-10-07T10:05:00Z", "Fixture without kind", null),
            room("g", null, "2026-10-07T10:06:00Z", "", "workflow"),
        )
        val entries = roomTimelineEntries(events)
        assertEquals(events.size, entries.size)
        assertEquals(events.map { "event:" + it.getString("id") }, entries.map { it.key })
        val items = buildTimeline(entries, zone)
        val bubbles = items.filterIsInstance<TimelineItem.Bubble>()
        assertEquals(listOf("event:a", "event:b", "event:c", "event:e", "event:f"), bubbles.map { it.key })
        assertEquals(listOf(true, false, true, true, true), bubbles.map { it.startsGroup })
        assertEquals(listOf(false, false, false, true, false), bubbles.map { it.own })
        assertEquals(listOf("Joined", "workflow"), items.filterIsInstance<TimelineItem.Lifecycle>().map { it.line.text })
    }

    @Test fun unseenCountsOnlyOthersAfterTheAnchorAndPointsAtTheFirst() {
        val items = buildTimeline(portalTimelineEntries(listOf(
            portal(1, "assistant_message", "2026-10-07T10:00:00Z"),
            portal(2, "user_message", "2026-10-07T10:00:30Z"),
            portal(3, "assistant_message", "2026-10-07T10:01:00Z"),
            portal(4, "assistant_message", "2026-10-07T10:01:30Z"),
        )), zone)
        val summary = unseenSince(items, "message:1")!!
        assertEquals(2, summary.count)
        assertEquals("message:3", items[summary.firstIndex].key)
        assertNull(unseenSince(items, "message:4"))
        assertNull(unseenSince(items, null))
        assertNull(unseenSince(items, "message:gone"))
    }

    @Test fun roomDeliveriesCountAnswersOnlyFromReplyEvents() {
        val ask = ChatMessage.fromRoomEvent(room("q", "admin:1", "2026-10-07T10:00:00Z").put("deliveries", JSONArray()
            .put(JSONObject().put("address_id", "x").put("status", "completed"))
            .put(JSONObject().put("address_id", "y").put("status", "completed"))
            .put(JSONObject().put("address_id", "z").put("status", "unreachable"))
            .put(JSONObject().put("address_id", "w").put("status", "delivered"))))
        val answer = ChatMessage.fromRoomEvent(room("r", "agent:x", "2026-10-07T10:01:00Z").put("reply_to", "q"))
        val unrelated = ChatMessage.fromRoomEvent(room("s", "agent:w", "2026-10-07T10:02:00Z"))
        val summary = roomDeliverySummary(ask, listOf(ask, answer, unrelated))!!
        assertEquals(4, summary.asked)
        assertEquals(1, summary.count(RoomAnswerState.Answered))
        assertEquals(1, summary.count(RoomAnswerState.NoAnswer))
        assertEquals(1, summary.count(RoomAnswerState.Unreachable))
        assertEquals(1, summary.count(RoomAnswerState.Waiting))
        assertNull(roomDeliverySummary(answer, listOf(answer)))
    }

    @Test fun conferenceCountdownRoundsUpAndStopsAtZero() {
        val now = Instant.parse("2026-10-07T10:00:00Z")
        assertEquals(60L, minutesUntil("2026-10-07T11:00:00Z", now))
        assertEquals(1L, minutesUntil("2026-10-07T10:00:01Z", now))
        assertEquals(0L, minutesUntil("2026-10-07T09:59:00Z", now))
        assertNull(minutesUntil(null, now))
        assertNull(minutesUntil("soon", now))
        assertEquals("1h 30m", remainingLabel(90))
        assertEquals("2h", remainingLabel(120))
        assertEquals("45m", remainingLabel(45))
    }
}
