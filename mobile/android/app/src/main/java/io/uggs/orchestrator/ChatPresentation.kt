package io.uggs.orchestrator

import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

internal fun eventTime(event: JSONObject): Instant? = runCatching { Instant.parse(event.optString("created_at")) }.getOrNull()

internal fun messagesGrouped(first: JSONObject?, second: JSONObject?, zone: ZoneId = ZoneId.systemDefault()): Boolean {
    if (first == null || second == null || first.optString("type") != second.optString("type")) return false
    val start = eventTime(first) ?: return false
    val end = eventTime(second) ?: return false
    return Duration.between(start, end).seconds in 0..300 && start.atZone(zone).toLocalDate() == end.atZone(zone).toLocalDate()
}

internal sealed interface ChatRow {
    val key: String
    data class Day(val date: LocalDate, val cursor: Long) : ChatRow { override val key = "day:" + date + ":" + cursor }
    data class Message(val event: JSONObject, val joinsPrevious: Boolean, val joinsNext: Boolean) : ChatRow {
        override val key = "message:" + event.optLong("cursor")
    }
}

internal fun chatRows(events: List<JSONObject>, zone: ZoneId = ZoneId.systemDefault()): List<ChatRow> = buildList {
    val messages = conversationEvents(events)
    var priorDay: LocalDate? = null
    messages.forEachIndexed { index, event ->
        val date = eventTime(event)?.atZone(zone)?.toLocalDate()
        if (date != null && date != priorDay) { add(ChatRow.Day(date, event.optLong("cursor"))); priorDay = date }
        add(ChatRow.Message(event, messagesGrouped(messages.getOrNull(index - 1), event, zone), messagesGrouped(event, messages.getOrNull(index + 1), zone)))
    }
}

internal fun dayLabel(date: LocalDate, today: LocalDate = LocalDate.now()): String = when (date) {
    today -> "Today"
    today.minusDays(1) -> "Yesterday"
    else -> date.format(DateTimeFormatter.ofPattern(if (date.year == today.year) "EEE, d MMM" else "d MMM yyyy", Locale.ENGLISH))
}

internal fun timeLabel(instant: Instant, use24Hour: Boolean, zone: ZoneId = ZoneId.systemDefault()): String =
    instant.atZone(zone).format(DateTimeFormatter.ofPattern(if (use24Hour) "HH:mm" else "h:mm a", Locale.getDefault()))
