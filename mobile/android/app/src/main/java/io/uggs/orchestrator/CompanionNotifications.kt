package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/*
 * Pure model of conversation pushes (agent replies and questions, room messages) and of
 * their notification actions. PushService.kt and NotificationActions.kt turn these into
 * Android notifications and intents; everything here stays JVM-testable.
 */

/** One answer button of a question push: [id] is sent as the answer and `metadata.choice_value`. */
internal data class PromptOption(val id: String, val label: String)

/** Most answer buttons a notification shows; Android lays out at most three actions. */
internal const val NOTIFICATION_MAX_ACTIONS = 3
/** Messages kept in one room notification's conversation history. */
internal const val ROOM_NOTIFICATION_HISTORY = 6

/** The server's `options` field: a JSON array of at most six `{id,label}` objects. Malformed entries are skipped. */
internal fun parsePromptOptions(raw: String?): List<PromptOption> {
    if (raw.isNullOrBlank() || raw.length > 4096) return emptyList()
    val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        val item = array.optJSONObject(index) ?: return@mapNotNull null
        val id = (item.opt("id") as? String)?.takeIf { it.isNotBlank() && it.length <= 200 } ?: return@mapNotNull null
        val label = (item.opt("label") as? String)?.trim()?.takeIf { it.isNotEmpty() }?.take(60) ?: return@mapNotNull null
        PromptOption(id, label)
    }.distinctBy { it.id }.take(6)
}

/**
 * `conversation_key` of a push: `room:<id>` or `agent:<id>` (the server's agent form),
 * falling back to `room_id` for room pushes and `target_id` otherwise (older servers).
 */
internal fun pushConversationKey(data: Map<String, String>): ConversationKey? {
    val key = data["conversation_key"]?.takeIf { it.isNotBlank() && it.length <= 300 }
    val parsed = when {
        key == null -> null
        key.startsWith(ConversationKey.ROOM_PREFIX) -> ConversationKey.Room(key.removePrefix(ConversationKey.ROOM_PREFIX))
        key.startsWith("agent:") -> ConversationKey.Direct(key.removePrefix("agent:"))
        else -> null
    }
    if (parsed != null && parsed.id().isNotBlank()) return parsed
    val room = data["kind"] in setOf("room", "room_read")
    val target = (if (room) data["room_id"] ?: data["target_id"] else data["target_id"])?.takeIf { it.isNotBlank() && it.length <= 256 } ?: return null
    return if (room) ConversationKey.Room(target) else ConversationKey.Direct(target)
}

private fun ConversationKey.id() = when (this) { is ConversationKey.Direct -> agentId; is ConversationKey.Room -> roomId }

/** A push that belongs to one conversation: an agent reply or question (`reply`/`attention`) or a room message (`room`). */
internal data class ConversationPush(
    val kind: String,
    val notificationId: String,
    val key: ConversationKey,
    /** Room title, or the agent's name. */
    val title: String?,
    val sender: String?,
    val engine: String?,
    /** Neutral, server-bounded text; never message content for rooms. */
    val summary: String?,
    /** Portal event cursor of an agent push. */
    val eventCursor: Long?,
    /** Room event UUID (room pushes). */
    val eventId: String?,
    /** The event's `created_at`, exactly as sent (room `through`). */
    val ts: String?,
    val reason: String?,
    val promptId: String?,
    val answerMode: String?,
    val options: List<PromptOption>,
    val severity: String?,
) {
    val room get() = key is ConversationKey.Room
    val targetId get() = key.id()
    val time: Instant? get() = runCatching { Instant.parse(ts) }.getOrNull()
}

private fun Map<String, String>.field(name: String, max: Int = 256): String? = this[name]?.trim()?.takeIf { it.isNotEmpty() && it.length <= max }

/** Null for approvals, read syncs, unknown kinds and malformed data. */
internal fun parseConversationPush(data: Map<String, String>): ConversationPush? {
    val kind = data["kind"]?.takeIf { it in setOf("reply", "attention", "room") } ?: return null
    val id = data.field("notification_id") ?: return null
    val key = pushConversationKey(data) ?: return null
    if ((kind == "room") != (key is ConversationKey.Room)) return null
    val prompt = data.field("prompt_id")?.takeIf { key is ConversationKey.Direct }
    return ConversationPush(
        kind = kind, notificationId = id, key = key,
        title = data.field(if (kind == "room") "room_title" else "agent_name", 200),
        sender = data.field("sender_name", 200) ?: data.field("agent_name", 200),
        engine = data.field("engine", 40),
        summary = compactSummary(data["summary"]),
        eventCursor = data["event_cursor"]?.toLongOrNull()?.takeIf { it > 0 },
        eventId = data.field("event_id", 64),
        ts = data.field("ts", 64),
        reason = data.field("reason", 40),
        promptId = prompt,
        answerMode = data.field("answer_mode", 40),
        options = if (prompt != null) parsePromptOptions(data["options"]) else emptyList(),
        severity = data["severity"]?.takeIf { it in setOf("important", "critical", "blocker") },
    )
}

internal enum class PushActionKind { Reply, MarkRead, Answer }
internal data class PushAction(val kind: PushActionKind, val option: PromptOption? = null)

/**
 * Notification buttons, at most [NOTIFICATION_MAX_ACTIONS]: answer buttons of a question
 * first, then Reply and Mark read in the slots left. Free-text-only questions get no buttons.
 */
internal fun pushActions(push: ConversationPush): List<PushAction> {
    val answers = if (push.promptId != null && push.answerMode != "text") push.options.map { PushAction(PushActionKind.Answer, it) } else emptyList()
    return (answers.take(NOTIFICATION_MAX_ACTIONS) + PushAction(PushActionKind.Reply) + PushAction(PushActionKind.MarkRead)).take(NOTIFICATION_MAX_ACTIONS)
}

/** Stable per notification and content: a repeated delivery of the same action resends the same id, so the server deduplicates it. */
internal fun notificationSendId(notificationId: String, discriminator: String): String =
    UUID.nameUUIDFromBytes("notification:$notificationId:$discriminator".toByteArray(Charsets.UTF_8)).toString()

/**
 * The outbox entry of a typed reply. Rooms share without asking (`/rooms/send`) and quote the
 * notified event; an open question is answered with the text; otherwise a plain message.
 */
internal fun notificationReplyEntry(push: ConversationPush, text: String, createdAt: String): OutboxEntry? {
    val content = text.trim().takeIf { it.isNotEmpty() } ?: return null
    val uuid = notificationSendId(push.notificationId, "reply:$content")
    return when (val key = push.key) {
        is ConversationKey.Room -> {
            val body = roomSendBody(key.roomId, uuid, content, emptyList(), RoomRecipients.Share, push.eventId)
            OutboxEntry(uuid, key.storageKey, "/rooms/send", body.toString(), createdAt)
        }
        is ConversationKey.Direct -> {
            val metadata = JSONObject().put("attachments", JSONArray())
            val prompt = push.promptId
            val body = JSONObject().put("client_message_id", uuid).put(if (prompt != null) "answer" else "content", content).put("metadata", metadata)
            OutboxEntry(uuid, key.storageKey, if (prompt != null) "/agents/${key.agentId}/prompts/$prompt/answer" else "/agents/${key.agentId}/messages", body.toString(), createdAt)
        }
    }
}

/** An answer button: `{client_message_id, answer:<id>, metadata:{choice_value:<id>}}`, like the in-app decision card, without a version. */
internal fun notificationAnswerEntry(push: ConversationPush, option: PromptOption, createdAt: String): OutboxEntry? {
    val key = push.key as? ConversationKey.Direct ?: return null
    val prompt = push.promptId ?: return null
    val uuid = notificationSendId(push.notificationId, "answer:$prompt")
    val body = JSONObject().put("client_message_id", uuid).put("answer", option.id)
        .put("metadata", JSONObject().put("attachments", JSONArray()).put("choice_value", option.id))
    return OutboxEntry(uuid, key.storageKey, "/agents/${key.agentId}/prompts/$prompt/answer", body.toString(), createdAt)
}

/**
 * Everything an action needs once the notification is gone, carried as intent extras
 * (strings only). [scope] fences a pairing change between posting and tapping.
 */
internal data class NotificationActionRequest(
    val action: PushActionKind,
    val scope: String,
    val tag: String?,
    val id: Int,
    val push: ConversationPush,
    val option: PromptOption? = null,
) {
    fun extras(): Map<String, String> = buildMap {
        put("action", action.name); put("scope", scope); put("notification_id_int", id.toString())
        tag?.let { put("tag", it) }
        put("kind", push.kind); put("notification_id", push.notificationId); put("conversation_key", push.key.storageKey)
        push.title?.let { put("title", it) }; push.sender?.let { put("sender", it) }
        push.eventCursor?.let { put("event_cursor", it.toString()) }; push.eventId?.let { put("event_id", it) }
        push.ts?.let { put("ts", it) }; push.promptId?.let { put("prompt_id", it) }
        option?.let { put("option_id", it.id); put("option_label", it.label) }
    }

    companion object {
        fun parse(extras: Map<String, String?>): NotificationActionRequest? = runCatching {
            val action = PushActionKind.valueOf(extras["action"]!!)
            val key = ConversationKey.fromStorageKey(extras["conversation_key"]!!.also { require(it.isNotBlank()) })
            val kind = extras["kind"]!!
            require((kind == "room") == (key is ConversationKey.Room))
            val push = ConversationPush(kind, extras["notification_id"]!!.also { require(it.isNotBlank()) }, key, extras["title"], extras["sender"], null, null,
                extras["event_cursor"]?.toLongOrNull(), extras["event_id"], extras["ts"], null, extras["prompt_id"]?.takeIf { key is ConversationKey.Direct }, null, emptyList(), null)
            val option = extras["option_id"]?.let { PromptOption(it, extras["option_label"].orEmpty()) }
            require(action != PushActionKind.Answer || (option != null && push.promptId != null))
            NotificationActionRequest(action, extras["scope"]!!, extras["tag"], extras["notification_id_int"]!!.toInt(), push, option)
        }.getOrNull()
    }
}

/** One line of a room notification's conversation history. */
internal data class NotificationLine(val sender: String?, val text: String, val time: Long)

/** Appends [line] to a notification's history, keeping the newest [ROOM_NOTIFICATION_HISTORY] in time order. */
internal fun appendNotificationLine(history: List<NotificationLine>, line: NotificationLine): List<NotificationLine> =
    (history + line).sortedBy { it.time }.takeLast(ROOM_NOTIFICATION_HISTORY)
