package io.uggs.orchestrator

import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/*
 * Shared timeline model for direct Portal chats and rooms. Pure Kotlin so the
 * grouping, day separators and status collapsing are JVM-testable; the
 * composables in ChatTimelineUi.kt only draw these items.
 */

/** A compact non-bubble line: status chatter or a lifecycle marker. */
internal data class StatusLine(val text: String, val time: Instant?, val tone: Tone = Tone.Neutral, val monospace: Boolean = false) {
    enum class Tone { Neutral, Success, Failure }
}

/** Ungrouped input of [buildTimeline], in display order. */
internal sealed interface TimelineEntry {
    val key: String
    val time: Instant?

    /** [group] identifies the speaker; consecutive entries with the same group may share one bubble group. */
    data class Message(val message: ChatMessage, val own: Boolean, val group: String, val source: JSONObject, override val key: String) : TimelineEntry {
        override val time get() = message.createdAt
    }
    data class Status(val line: StatusLine, override val key: String) : TimelineEntry { override val time get() = line.time }
    data class Lifecycle(val line: StatusLine, override val key: String) : TimelineEntry { override val time get() = line.time }
    /** A question the agent asked earlier; only the current question is answerable. */
    data class Decision(val prompt: JSONObject, override val time: Instant?, override val key: String) : TimelineEntry
}

internal sealed interface TimelineItem {
    val key: String
    data class Day(val date: LocalDate, override val key: String) : TimelineItem
    /** Author name and avatar show at [startsGroup]; the time shows at [endsGroup]. */
    data class Bubble(val message: ChatMessage, val own: Boolean, val startsGroup: Boolean, val endsGroup: Boolean, val source: JSONObject, override val key: String) : TimelineItem
    /** Consecutive status events, collapsed into one expandable row. */
    data class StatusRun(val lines: List<StatusLine>, override val key: String) : TimelineItem
    data class Lifecycle(val line: StatusLine, override val key: String) : TimelineItem
    data class Decision(val prompt: JSONObject, override val key: String) : TimelineItem
}

/** Bubbles from the same speaker merge while they stay this close (and on the same day). */
internal const val GROUP_GAP_SECONDS = 300L

internal fun buildTimeline(entries: List<TimelineEntry>, zone: ZoneId = ZoneId.systemDefault()): List<TimelineItem> = buildList {
    var priorDay: LocalDate? = null
    var index = 0
    fun day(entry: TimelineEntry) = entry.time?.atZone(zone)?.toLocalDate()
    fun joins(first: TimelineEntry?, second: TimelineEntry?): Boolean {
        if (first !is TimelineEntry.Message || second !is TimelineEntry.Message || first.group != second.group) return false
        val start = first.time ?: return false
        val end = second.time ?: return false
        return Duration.between(start, end).seconds in 0..GROUP_GAP_SECONDS && day(first) == day(second)
    }
    while (index < entries.size) {
        val entry = entries[index]
        val date = day(entry)
        if (date != null && date != priorDay) { add(TimelineItem.Day(date, "day:$date:${entry.key}")); priorDay = date }
        when (entry) {
            is TimelineEntry.Status -> {
                // Always collapse, even a single line and even at the tail: progress
                // chatter must never bury a reply. Liveness is the working indicator's job.
                var end = index
                while (end + 1 < entries.size && entries[end + 1] is TimelineEntry.Status && day(entries[end + 1]).let { it == null || it == date || date == null }) end++
                val run = entries.subList(index, end + 1).map { (it as TimelineEntry.Status).line }
                add(TimelineItem.StatusRun(run, "status:${entry.key}"))
                index = end + 1
                continue
            }
            is TimelineEntry.Lifecycle -> add(TimelineItem.Lifecycle(entry.line, entry.key))
            is TimelineEntry.Decision -> add(TimelineItem.Decision(entry.prompt, entry.key))
            is TimelineEntry.Message -> add(TimelineItem.Bubble(entry.message, entry.own,
                !joins(entries.getOrNull(index - 1), entry), !joins(entry, entries.getOrNull(index + 1)), entry.source, entry.key))
        }
        index++
    }
}

internal fun MessageKey.itemKey(): String = when (this) {
    is MessageKey.PortalEvent -> "message:$cursor"
    is MessageKey.RoomEvent -> "event:$id"
    is MessageKey.Notice -> "notice:$id"
}

private val PORTAL_RECEIPTS = setOf("message_accepted", "message_read", "message_processing", "message_canceled")
private val PORTAL_LIFECYCLE = setOf("started", "resumed", "completed", "failed", "close_requested", "attention_resolved")

private fun JSONObject.str(key: String): String? = (opt(key) as? String)?.takeIf { it.isNotBlank() }

internal fun portalLifecycleText(t: Texts, event: JSONObject): String {
    val payload = event.optJSONObject("payload") ?: JSONObject()
    val summary = payload.str("summary") ?: payload.str("text")
    return when (event.optString("type")) {
        "started" -> summary ?: t.string(R.string.lifecycle_started)
        "resumed" -> summary ?: t.string(R.string.lifecycle_resumed)
        "completed" -> summary ?: t.string(R.string.lifecycle_completed)
        "failed" -> summary ?: t.string(R.string.lifecycle_failed)
        "close_requested" -> summary ?: t.string(R.string.lifecycle_close_requested)
        "attention_resolved" -> summary?.let { t.string(R.string.lifecycle_attention_resolved_with, it) } ?: t.string(R.string.lifecycle_attention_resolved)
        else -> summary ?: event.optString("type").replace('_', ' ')
    }
}

internal fun portalStatusText(t: Texts, event: JSONObject): String {
    val payload = event.optJSONObject("payload") ?: JSONObject()
    return payload.str("text") ?: payload.str("summary") ?: payload.str("question") ?: event.optString("type").replace('_', ' ').ifBlank { t.string(R.string.timeline_update) }
}

/**
 * The direct-chat timeline: bubbles by the [conversationEvents] rules, plus status
 * runs, lifecycle markers and earlier questions. Receipts are never rows; the
 * current [prompt] is drawn as the answerable card after the timeline instead.
 * [notices] are unresolved notices the server tail may have dropped; they are kept at their own time.
 */
internal fun portalTimelineEntries(t: Texts, events: List<JSONObject>, notices: List<JSONObject> = emptyList(), prompt: JSONObject? = null): List<TimelineEntry> {
    val entries = mutableListOf<TimelineEntry>()
    events.forEach { event ->
        val type = event.optString("type")
        val payload = event.optJSONObject("payload") ?: JSONObject()
        val cursor = event.optLong("cursor")
        when {
            type in PORTAL_RECEIPTS -> Unit
            // A failed delivery is a receipt for its instruction, not a lifecycle event.
            type == "failed" && payload.str("message_id") != null -> Unit
            type in setOf("user_message", "assistant_message") || (type in setOf("attention", "waiting_input") && noticeSeverity(payload) != null) ->
                ChatMessage.fromPortalEvent(event)?.let { entries.add(TimelineEntry.Message(it, type == "user_message", type + ":" + noticeSeverity(payload), event, it.key.itemKey())) }
            type == "attention" -> Unit
            type == "waiting_input" -> {
                val current = prompt != null && payload.str("prompt_id") == prompt.optString("id") &&
                    (!payload.has("prompt_version") || !prompt.has("version") || payload.optInt("prompt_version") == prompt.optInt("version"))
                if (!current && (payload.str("question") != null || payload.str("text") != null))
                    entries.add(TimelineEntry.Decision(if (payload.has("question")) payload else JSONObject(payload.toString()).put("question", payload.optString("text")), eventTime(event), "decision:$cursor"))
            }
            type in PORTAL_LIFECYCLE -> entries.add(TimelineEntry.Lifecycle(StatusLine(portalLifecycleText(t, event), eventTime(event), when (type) {
                "completed" -> StatusLine.Tone.Success; "failed" -> StatusLine.Tone.Failure; else -> StatusLine.Tone.Neutral
            }), "lifecycle:$cursor"))
            else -> entries.add(TimelineEntry.Status(StatusLine(portalStatusText(t, event), eventTime(event), monospace = type == "terminal_block"), "s:$cursor"))
        }
    }
    // Keep an older unresolved notice the server tail omitted, at its own time,
    // without inventing a transcript cursor or duplicating a retained one.
    val retained = entries.mapNotNull { (it as? TimelineEntry.Message)?.message?.noticeId }.toMutableSet()
    notices.forEach { notice ->
        val id = notice.str("id") ?: return@forEach
        if (noticeSeverity(notice) == null || !retained.add(id)) return@forEach
        val event = JSONObject().put("type", "attention").put("notice_preview", true)
            .put("created_at", notice.optString("since"))
            .put("payload", JSONObject().put("notice_id", id).put("severity", notice.optString("severity")).put("summary", notice.optString("summary")))
        val message = ChatMessage.fromPortalEvent(event)?.copy(key = MessageKey.Notice(id)) ?: return@forEach
        val time = message.createdAt
        val index = if (time == null) -1 else entries.indexOfFirst { it.time?.isAfter(time) == true }
        val entry = TimelineEntry.Message(message, false, "attention:" + message.severity, event, message.key.itemKey())
        entries.add(if (index < 0) entries.size else index, entry)
    }
    return entries
}

/** Every room event maps to exactly one item, so "seen" can watch the newest event's row. */
internal fun roomTimelineEntries(t: Texts, events: List<JSONObject>): List<TimelineEntry> = events.map { event ->
    val message = ChatMessage.fromRoomEvent(event)
    val key = message.key.itemKey()
    when {
        message.kind == ChatItemKind.Membership ->
            TimelineEntry.Lifecycle(StatusLine(message.text.ifBlank { t.string(R.string.timeline_participants_changed) }, message.createdAt), key)
        message.text.isNotBlank() || message.attachments.isNotEmpty() ->
            TimelineEntry.Message(message, message.author.role == ChatAuthor.Role.Operator,
                message.author.role.name + ":" + (message.author.id ?: message.author.name.orEmpty()), event, key)
        else -> TimelineEntry.Lifecycle(StatusLine(message.rawKind.replace('_', ' ').ifBlank { t.string(R.string.timeline_update) }, message.createdAt), key)
    }
}

/** Where a "New messages" jump lands: the first item after [anchorKey], and how many bubbles from others arrived since. */
internal data class UnseenSummary(val firstIndex: Int, val count: Int)

internal fun unseenSince(items: List<TimelineItem>, anchorKey: String?): UnseenSummary? {
    val anchor = items.indexOfFirst { it.key == anchorKey }
    if (anchorKey == null || anchor < 0) return null
    val after = items.drop(anchor + 1)
    val count = after.count { it is TimelineItem.Bubble && !it.own }
    val first = after.indexOfFirst { it is TimelineItem.Bubble && !it.own }
    return if (count == 0 || first < 0) null else UnseenSummary(anchor + 1 + first, count)
}

/** Delivery state of one room answer request. "Answered" is proven by a reply event, never inferred from transport status. */
internal enum class RoomAnswerState { Answered, Waiting, Unreachable, NoAnswer }

internal data class RoomDeliverySummary(val asked: Int, val states: List<Pair<String?, RoomAnswerState>>) {
    fun count(state: RoomAnswerState) = states.count { it.second == state }
}

private val ROOM_UNREACHABLE = setOf("unreachable", "wrapper_update_required")
private val ROOM_TERMINAL = setOf("completed", "dead", "expired", "canceled", "ambiguous")

internal fun roomDeliverySummary(message: ChatMessage, events: List<ChatMessage>): RoomDeliverySummary? {
    if (message.deliveries.isEmpty()) return null
    val answered = events.filter { it.replyTo == message.key && it.author.id?.startsWith("agent:") == true }
        .mapNotNull { it.author.id?.removePrefix("agent:") }.toSet()
    return RoomDeliverySummary(message.deliveries.size, message.deliveries.map { delivery ->
        delivery.target to when {
            delivery.target != null && delivery.target in answered -> RoomAnswerState.Answered
            delivery.status in ROOM_UNREACHABLE -> RoomAnswerState.Unreachable
            delivery.status in ROOM_TERMINAL -> RoomAnswerState.NoAnswer
            else -> RoomAnswerState.Waiting
        }
    })
}

/** "1h 30m" / "45m": a compact remaining-time label. */
internal fun remainingLabel(t: Texts, minutes: Long): String = when {
    minutes >= 60 && minutes % 60 == 0L -> t.string(R.string.duration_h, minutes / 60)
    minutes >= 60 -> t.string(R.string.duration_h_m, minutes / 60, minutes % 60)
    else -> t.string(R.string.duration_m, minutes)
}

/** List timestamp, messenger style: clock time today, weekday within the week, a short date beyond. */
internal fun listTimeLabel(t: Texts, instant: Instant, now: Instant, use24Hour: Boolean, zone: ZoneId = ZoneId.systemDefault()): String {
    val date = instant.atZone(zone).toLocalDate()
    val today = now.atZone(zone).toLocalDate()
    return when {
        date == today -> timeLabel(t, instant, use24Hour, zone)
        !date.isBefore(today.minusDays(6)) && date.isBefore(today) -> date.format(java.time.format.DateTimeFormatter.ofPattern(t.pattern("EEE", "EEE"), t.locale))
        else -> date.format(java.time.format.DateTimeFormatter.ofPattern(
            if (date.year == today.year) t.pattern("dMMM", "d MMM") else t.pattern("dMMMy", "d MMM yyyy"), t.locale))
    }
}

/** Minutes left until a conference deadline, rounded up; 0 once it passed; null without a deadline. */
internal fun minutesUntil(deadline: String?, now: Instant): Long? {
    val end = runCatching { Instant.parse(deadline) }.getOrNull() ?: return null
    val seconds = Duration.between(now, end).seconds
    return if (seconds <= 0) 0 else (seconds + 59) / 60
}
