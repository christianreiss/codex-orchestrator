package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/*
 * Engine-neutral chat model shared by direct Portal chats and rooms.
 *
 * These types are a read-only projection of the server JSON. The shared chat
 * timeline (ChatTimeline.kt) is built on them for direct chats and rooms. The
 * mappers must agree with the presentation rules (for Portal, [conversationEvents]).
 */

/** Which conversation a message, draft or upload belongs to. */
sealed interface ConversationKey {
    /** Key used by the existing per-conversation maps (drafts, uploads): `<agentId>` or `room:<roomId>`. */
    val storageKey: String

    data class Direct(val agentId: String) : ConversationKey {
        override val storageKey get() = agentId
    }

    data class Room(val roomId: String) : ConversationKey {
        override val storageKey get() = ROOM_PREFIX + roomId
    }

    companion object {
        const val ROOM_PREFIX = "room:"
        fun fromStorageKey(key: String): ConversationKey =
            if (key.startsWith(ROOM_PREFIX)) Room(key.removePrefix(ROOM_PREFIX)) else Direct(key)
    }
}

/** Identity of one timeline item, and the target type of a reply reference. */
sealed interface MessageKey {
    /** Portal transcript cursor. Negative cursors are local send bubbles that the server has not confirmed. */
    data class PortalEvent(val cursor: Long) : MessageKey {
        val local get() = cursor < 0
    }

    /** Room event UUID. */
    data class RoomEvent(val id: String) : MessageKey

    /** An unresolved Portal notice kept in view although the transcript tail no longer holds its event. */
    data class Notice(val id: String) : MessageKey
}

enum class ChatItemKind { Message, Notice, Membership, Other }

/**
 * Who wrote an item. [role] says which side of the conversation spoke; it does
 * not say whether this device's operator wrote it (rooms can have several admins).
 */
data class ChatAuthor(val role: Role, val id: String? = null, val name: String? = null) {
    enum class Role { Operator, Agent, Unknown }
}

/** One delivery state. [target] is a room member address id, or null for the single Portal recipient. */
data class ChatDelivery(val target: String?, val status: String)

data class ChatMessage(
    val key: MessageKey,
    val author: ChatAuthor,
    val text: String,
    val attachments: List<String>,
    val replyTo: MessageKey?,
    val kind: ChatItemKind,
    /** Server type (`user_message`, `attention`, …) or room `kind` (`chat`, `membership`, …). */
    val rawKind: String,
    val createdAt: Instant?,
    val createdAtRaw: String,
    /** Portal receipt correlation id (`payload.message_id`); null for rooms. */
    val messageId: String? = null,
    /** Client id of an unconfirmed local Portal send. */
    val localId: String? = null,
    /** Local Portal send state (`sending`, `queued`, `unconfirmed`, `failed`) before server receipts exist. */
    val localStatus: String? = null,
    val deliveries: List<ChatDelivery> = emptyList(),
    /** Notice severity for Portal `attention` / `waiting_input` items. */
    val severity: String? = null,
    val noticeId: String? = null,
) {
    companion object
}

/**
 * Maps one Portal transcript event. Returns null for events the conversation
 * does not show as a bubble (receipts, progress, empty messages), by the same
 * rule as [conversationEvents]. [receipts] is the [deliveryIndex] of the
 * transcript; receipts are separate events and cannot be read from one event.
 */
fun ChatMessage.Companion.fromPortalEvent(event: JSONObject, receipts: Map<String, String> = emptyMap()): ChatMessage? {
    if (conversationEvents(listOf(event)).isEmpty()) return null
    val type = event.optString("type")
    val payload = event.optJSONObject("payload") ?: JSONObject()
    val severity = noticeSeverity(payload)
    val messageId = payload.text("message_id")
    val createdAt = event.optString("created_at")
    return ChatMessage(
        key = MessageKey.PortalEvent(event.optLong("cursor")),
        author = ChatAuthor(if (type == "user_message") ChatAuthor.Role.Operator else ChatAuthor.Role.Agent),
        text = messageText(event),
        attachments = payload.optJSONArray("attachments").stringList(),
        replyTo = payload.optLong("reply_to").takeIf { it > 0 }?.let { MessageKey.PortalEvent(it) },
        kind = if (severity != null) ChatItemKind.Notice else ChatItemKind.Message,
        rawKind = type,
        createdAt = eventTime(event),
        createdAtRaw = createdAt,
        messageId = messageId,
        localId = payload.text("local_send_id"),
        localStatus = payload.text("delivery_status"),
        deliveries = messageId?.let { receipts[it] }?.let { listOf(ChatDelivery(null, it)) } ?: emptyList(),
        severity = severity,
        noticeId = if (severity != null) payload.text("notice_id") else null,
    )
}

/** Maps one room event (`RoomEvent` in the server's agent-room-chat contract). */
fun ChatMessage.Companion.fromRoomEvent(event: JSONObject): ChatMessage {
    val actor = event.text("actor")
    val createdAt = event.optString("created_at")
    return ChatMessage(
        key = MessageKey.RoomEvent(event.getString("id")),
        author = ChatAuthor(
            when {
                actor?.startsWith("admin:") == true -> ChatAuthor.Role.Operator
                actor?.startsWith("agent:") == true -> ChatAuthor.Role.Agent
                else -> ChatAuthor.Role.Unknown
            },
            actor, event.text("name"),
        ),
        text = event.optString("content"),
        attachments = event.optJSONArray("attachments").stringList(),
        replyTo = event.text("reply_to")?.let { MessageKey.RoomEvent(it) },
        kind = when (event.optString("kind")) {
            "chat" -> ChatItemKind.Message
            "membership" -> ChatItemKind.Membership
            else -> ChatItemKind.Other
        },
        rawKind = event.optString("kind"),
        createdAt = eventTime(event),
        createdAtRaw = createdAt,
        deliveries = event.optJSONArray("deliveries")?.objects()?.mapNotNull { delivery ->
            delivery.text("status")?.let { ChatDelivery(delivery.text("address_id"), it) }
        } ?: emptyList(),
    )
}

/** A string field, or null when it is missing, JSON null or blank. */
private fun JSONObject.text(key: String): String? = (opt(key) as? String)?.takeIf { it.isNotBlank() }

private fun JSONArray?.stringList(): List<String> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { opt(it) as? String }.distinct()
