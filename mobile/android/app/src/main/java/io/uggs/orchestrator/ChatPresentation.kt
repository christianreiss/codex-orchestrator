package io.uggs.orchestrator

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal fun eventTime(event: JSONObject): Instant? = runCatching { Instant.parse(event.optString("created_at")) }.getOrNull()

internal fun dayLabel(t: Texts, date: LocalDate, today: LocalDate = LocalDate.now()): String = when (date) {
    today -> t.string(R.string.time_today)
    today.minusDays(1) -> t.string(R.string.time_yesterday)
    else -> date.format(DateTimeFormatter.ofPattern(
        if (date.year == today.year) t.pattern("EEEdMMM", "EEE, d MMM") else t.pattern("dMMMy", "d MMM yyyy"), t.locale))
}

internal fun timeLabel(t: Texts, instant: Instant, use24Hour: Boolean, zone: ZoneId = ZoneId.systemDefault()): String =
    instant.atZone(zone).format(DateTimeFormatter.ofPattern(if (use24Hour) t.pattern("Hm", "HH:mm") else t.pattern("hm", "h:mm a"), t.locale))

/** Receipts are keyed to the instruction, never inferred from a later unrelated reply. */
internal fun deliveryIndex(events: List<JSONObject>): Map<String, String> {
    val result = mutableMapOf<String, String>()
    val ranks = mapOf("delivered" to 1, "read" to 2, "processing" to 3, "replied" to 4)
    events.forEach { event ->
        val id = event.optJSONObject("payload")?.receiptString("message_id") ?: return@forEach
        val state = when (event.optString("type")) {
            "message_accepted" -> "delivered"
            "message_read" -> "read"
            "message_processing" -> "processing"
            "assistant_message" -> "replied"
            else -> null
        }
        val current = result[id]
        if (state != null && (ranks[state] ?: 0) >= (ranks[current] ?: 0)) result[id] = state
        else if (state == null && (ranks[current] ?: 0) == 0) {
            if (event.optString("type") == "message_canceled") result[id] = "canceled"
            else if (event.optString("type") == "failed" && current == null) result[id] = "failed"
        }
    }
    return result
}

internal fun deliveryLabel(t: Texts, event: JSONObject, receipts: Map<String, String>, agent: JSONObject?, fresh: Boolean): String? {
    if (event.optString("type") != "user_message") return null
    val id = event.optJSONObject("payload")?.receiptString("message_id") ?: return null
    return when (receipts[id]) {
        "delivered" -> t.string(R.string.delivery_delivered)
        "read" -> t.string(R.string.delivery_read)
        "processing" -> if (fresh && agent?.optString("presence") == "working" && agent.receiptString("active_turn_id") == id) t.string(R.string.delivery_working) else t.string(R.string.delivery_read)
        "replied" -> t.string(R.string.delivery_replied)
        "canceled" -> t.string(R.string.delivery_canceled)
        "failed" -> t.string(R.string.chat_send_failed)
        else -> when (event.optJSONObject("payload")?.optString("delivery_status")) {
            "sending" -> t.string(R.string.chat_send_sending)
            "unconfirmed" -> t.string(R.string.chat_send_unconfirmed)
            "failed" -> t.string(R.string.chat_send_failed)
            else -> t.string(R.string.delivery_queued)
        }
    }
}

private fun JSONObject.receiptString(key: String): String? = (opt(key) as? String)?.takeIf { it.isNotBlank() }

internal data class ReplyPreview(val author: String, val text: String)

/** Quote only retained message content; an expired reference must not quote a different event. */
internal fun replyPreview(t: Texts, events: List<JSONObject>, cursor: Long, agentName: String): ReplyPreview {
    val event = conversationEvents(events).firstOrNull { it.optLong("cursor") == cursor }
        ?: return ReplyPreview(t.string(R.string.reply_earlier), t.string(R.string.reply_unavailable))
    val payload = event.optJSONObject("payload")
    val text = messageText(event).trim()
    val attachments = payload?.optJSONArray("attachments")?.length() ?: 0
    return ReplyPreview(if (event.optString("type") == "user_message") t.string(R.string.reply_you) else agentName,
        text.ifBlank { if (attachments == 1) t.string(R.string.reply_attachment) else if (attachments > 1) t.plural(R.plurals.reply_attachments, attachments, attachments) else t.string(R.string.reply_message) })
}
