package io.uggs.orchestrator

import org.json.JSONObject

/** Local send feedback stays separate from server cursors and delivery receipts. */
internal data class PendingChat(
    val clientId: String,
    val cursor: Long,
    val text: String,
    val metadata: String,
    val createdAt: String,
    val status: String = "sending",
    val messageId: String? = null,
) {
    fun event(): JSONObject = JSONObject().put("cursor", cursor).put("type", "user_message")
        .put("created_at", createdAt).put("payload", JSONObject(metadata)
            .put("text", text).put("message_id", messageId ?: clientId)
            .put("local_send_id", clientId).put("delivery_status", status))
}

internal fun pendingChatsAfterRefresh(pending: List<PendingChat>, events: List<JSONObject>): List<PendingChat> {
    val confirmed = events.filter { it.optString("type") == "user_message" }
        .mapNotNull { it.optJSONObject("payload")?.optString("message_id") }.toSet()
    return pending.filter { it.messageId == null || it.messageId !in confirmed }
}
