package io.uggs.orchestrator

import org.json.JSONObject
import java.util.UUID

/** One direct-chat send intent; [uuid] is the idempotent `client_message_id` reused by retries. */
internal data class ChatSend(val session: String, val target: String, val text: String, val metadata: String, val uuid: String, val version: Int?)

/**
 * Reuses the last unconfirmed intent with the same text and metadata (and prompt),
 * so a repeated tap retries the same server message instead of creating a new one.
 */
internal fun chatSendIntent(sends: Collection<ChatSend>, id: String, prompt: JSONObject?, text: String, metadata: JSONObject): ChatSend {
    val previous = sends.lastOrNull { it.session == id && it.text == text && it.metadata == metadata.toString() }
    return if (previous != null && (prompt == null || previous.target.contains("/${prompt.optString("id")}/")) && previous.text == text && previous.metadata == metadata.toString()) previous else ChatSend(
        id, if (prompt != null) "/agents/$id/prompts/${prompt.getString("id")}/answer" else "/agents/$id/messages", text, metadata.toString(), UUID.randomUUID().toString(), prompt?.optInt("version", 1))
}

/** The request body of [this] intent; frozen into the outbox before the first attempt. */
internal fun ChatSend.body(): JSONObject = JSONObject().put("client_message_id", uuid)
    .put(if (version != null) "answer" else "content", text).put("metadata", JSONObject(metadata))
    .apply { version?.let { put("version", it) } }

internal fun ChatSend.outboxEntry(createdAt: String) = OutboxEntry(uuid, session, target, body().toString(), createdAt)

/** Rebuilds the intent of a persisted direct send, e.g. after a restart; null for a room or unreadable entry. */
internal fun chatSendFromOutbox(entry: OutboxEntry): ChatSend? = if (entry.room) null else runCatching {
    val body = JSONObject(entry.body)
    require(body.getString("client_message_id") == entry.id)
    val answer = body.has("answer")
    ChatSend(entry.conversation, entry.path, if (answer) body.getString("answer") else body.getString("content"),
        (body.optJSONObject("metadata") ?: JSONObject()).toString(), entry.id, if (body.has("version")) body.getInt("version") else null)
}.getOrNull()
