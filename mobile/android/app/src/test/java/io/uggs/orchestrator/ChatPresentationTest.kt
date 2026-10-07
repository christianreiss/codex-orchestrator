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
        assertTrue(chatRows(listOf(first, second), zone).all { it is ChatRow.Message })
    }

    @Test fun transcriptKeepsCursorOrderAndAddsLocalDaysWithoutSystemNoise() {
        val events = listOf(
            message(1, "assistant_message", "2026-10-07T21:59:00Z"),
            message(2, "receiver_ready", "2026-10-07T21:59:10Z"),
            message(3, "assistant_message", "2026-10-07T21:59:30Z"),
            message(4, "user_message", "2026-10-07T22:00:00Z"),
        )
        val rows = chatRows(events, zone)
        assertEquals(listOf(LocalDate.parse("2026-10-07"), LocalDate.parse("2026-10-08")), rows.filterIsInstance<ChatRow.Day>().map { it.date })
        val messages = rows.filterIsInstance<ChatRow.Message>()
        assertEquals(listOf(1L, 3L, 4L), messages.map { it.event.getLong("cursor") })
        assertTrue(messages[0].joinsNext); assertTrue(messages[1].joinsPrevious)
        assertFalse(messages[1].joinsNext); assertFalse(messages[2].joinsPrevious)
    }

    @Test fun changingClockDoesNotCreateDuplicateListKeys() {
        val rows = chatRows(listOf(
            message(1, "assistant_message", "2026-10-07T21:59:00Z"),
            message(2, "assistant_message", "2026-10-07T22:01:00Z"),
            message(3, "assistant_message", "2026-10-07T21:59:59Z"),
        ), zone)
        assertEquals(rows.size, rows.map { it.key }.toSet().size)
        assertEquals("Today", dayLabel(LocalDate.parse("2026-10-07"), LocalDate.parse("2026-10-07")))
        assertEquals("Yesterday", dayLabel(LocalDate.parse("2026-10-06"), LocalDate.parse("2026-10-07")))
    }
}
