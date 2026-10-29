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
