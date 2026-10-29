package io.uggs.orchestrator

import org.json.JSONObject

internal data class LoadedHistory(val events: List<JSONObject>, val cursor: Long)

/**
 * Loads a direct (Portal) transcript on top of what is already shown:
 * [loaded] with [loadedCursor], tail-first when nothing was loaded yet.
 */
internal suspend fun loadDirectHistory(client: Api, id: String, expectedReply: Long, loaded: List<JSONObject>, loadedCursor: Long, eventsLoaded: Boolean): LoadedHistory {
    var result = loaded
    var cursor = maxOf(loadedCursor, result.maxOfOrNull { it.optLong("cursor") } ?: 0)
    var tail = !eventsLoaded
    // Retention or a restored server may have removed previously cached replies.
    if (expectedReply < (result.filter { it.optString("type") == "assistant_message" }.maxOfOrNull { it.optLong("cursor") } ?: 0)) {
        result = emptyList(); cursor = 0; tail = true
    }
    do {
        val page = client.request("/agents/$id/events?${if (tail) "tail=1" else "after=$cursor"}")
        val batch = page.getJSONArray("events").objects()
        result = mergeChatEvents(result, batch)
        val next = page.optLong("next_cursor", cursor)
        val advanced = next > cursor
        cursor = maxOf(cursor, next, batch.maxOfOrNull { it.optLong("cursor") } ?: 0)
        if (!advanced || batch.size < 250) break
        tail = false
    } while (true)
    // Progress can fill the tail without any visible chat message. Load
    // the exact last reply advertised by the authorized overview in that
    // case, rather than acknowledging a cursor whose text was never seen.
    if (expectedReply > 0 && result.none { it.optString("type") == "assistant_message" && it.optLong("cursor") >= expectedReply }) {
        val replyPage = client.request("/agents/$id/events?after=${expectedReply - 1}")
        result = mergeChatEvents(result, replyPage.getJSONArray("events").objects())
        cursor = maxOf(cursor, replyPage.optLong("next_cursor"), result.maxOfOrNull { it.optLong("cursor") } ?: 0)
    }
    return LoadedHistory(result, cursor)
}
