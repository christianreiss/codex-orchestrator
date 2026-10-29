package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

/*
 * Room reactions, pins and message search (server R5 protocols). Pure, so the optimistic toggle,
 * merge, parsing and highlight rules are JVM-tested; RoomChats.kt and MessageSearch do the I/O.
 * Reactions and pins exist for shared rooms only; direct Portal chats have neither.
 */

/** The picker's emoji, the same eight as the web console (`QUICK_REACTIONS`). */
internal val QUICK_REACTIONS = listOf("👍", "❤️", "😄", "🎉", "👀", "✅", "❌", "🚀")

internal data class RoomReaction(val emoji: String, val count: Int, val mine: Boolean)

/** The reactions of a canonical room event; null for an adapted legacy event, which carries no `reactions` field. */
internal fun roomReactions(event: JSONObject): List<RoomReaction>? {
    val array = event.optJSONArray("reactions") ?: return null
    return (0 until array.length()).mapNotNull { array.optJSONObject(it) }.mapNotNull { r ->
        r.optString("emoji").takeIf { it.isNotBlank() && it != "null" }?.let { RoomReaction(it, r.optInt("count"), r.optBoolean("mine")) }
    }.filter { it.count > 0 }
}

/** [event] (a copy) with [reactions] as its current reactions. */
internal fun withReactions(event: JSONObject, reactions: List<RoomReaction>): JSONObject =
    JSONObject(event.toString()).put("reactions", JSONArray(reactions.map { JSONObject().put("emoji", it.emoji).put("count", it.count).put("mine", it.mine) }))

/** The reactions after this operator turned [emoji] [on] or off; unchanged when it already is. */
internal fun toggleReaction(reactions: List<RoomReaction>, emoji: String, on: Boolean): List<RoomReaction> {
    val existing = reactions.firstOrNull { it.emoji == emoji }
    return when {
        on && existing == null -> reactions + RoomReaction(emoji, 1, true)
        on && existing != null && !existing.mine -> reactions.map { if (it.emoji == emoji) it.copy(count = it.count + 1, mine = true) else it }
        !on && existing != null && existing.mine ->
            if (existing.count <= 1) reactions.filter { it.emoji != emoji }
            else reactions.map { if (it.emoji == emoji) it.copy(count = it.count - 1, mine = false) else it }
        else -> reactions
    }
}

/** The room's pinned event ids (newest first) of a read, delta or toggle answer; null when the answer carries none. */
internal fun roomPinned(response: JSONObject): List<String>? = response.optJSONArray("pinned")?.let { array ->
    (0 until array.length()).mapNotNull { (array.opt(it) as? String)?.takeIf(String::isNotBlank) }
}

/** One entry of `GET /rooms/:roomId/pins`; [snippet] is null once retention removed the event. */
internal data class RoomPin(val eventId: String, val pinnedBy: String?, val pinnedAt: String, val snippet: String?, val author: String?, val createdAt: String?)

internal fun parseRoomPins(response: JSONObject): List<RoomPin> = response.optJSONArray("pins")?.let { array ->
    (0 until array.length()).mapNotNull { array.optJSONObject(it) }.mapNotNull { pin ->
        val id = pin.optString("event_id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val event = pin.optJSONObject("event")
        RoomPin(id, pin.optString("pinned_by").takeIf { it.isNotBlank() && it != "null" }, pin.optString("pinned_at"),
            event?.let { it.optString("snippet") }, event?.optString("name")?.takeIf { it.isNotBlank() && it != "null" }, event?.optString("created_at"))
    }
}.orEmpty()

/** Applies a pin toggle to the id list optimistically: a new pin goes first (newest first), an unpin removes. */
internal fun togglePinned(pinned: List<String>, eventId: String, on: Boolean): List<String> =
    if (on) listOf(eventId) + (pinned - eventId) else pinned - eventId

/** What the operator reads for a failed reaction or pin toggle. */
internal fun annotationError(t: Texts, e: Throwable, pin: Boolean): String {
    if (e is ApiException) {
        when {
            e.status == 429 || e.code == "rate_limited" ->
                return e.retryAfterSeconds?.let { t.plural(R.plurals.annotation_rate_limited, it, it) } ?: t.string(R.string.annotation_rate_limited_soon)
            e.code == "reaction_limit" -> return t.string(R.string.reaction_limit)
            e.code == "room_pin_limit" -> return t.string(R.string.pin_limit)
        }
        return e.message?.takeIf { it.isNotBlank() } ?: t.string(if (pin) R.string.pin_failed else R.string.reaction_failed)
    }
    return t.string(if (pin) R.string.pin_failed else R.string.reaction_failed)
}

/* ---- Search ---- */

internal const val SEARCH_MIN_CHARS = 2
internal const val SEARCH_MAX_CHARS = 200

internal enum class SearchScope(val wire: String) { All("all"), Rooms("rooms"), Direct("direct") }

/** The query as the server reads it: whitespace collapsed; null while shorter than [SEARCH_MIN_CHARS]. */
internal fun normalizedQuery(raw: String): String? =
    raw.trim().replace(Regex("\\s+"), " ").take(SEARCH_MAX_CHARS).trim().takeIf { it.length >= SEARCH_MIN_CHARS }

internal fun searchPath(query: String, scope: SearchScope, cursor: String?): String =
    "/search?q=${URLEncoder.encode(query, "UTF-8")}&scope=${scope.wire}&limit=20" + (cursor?.let { "&cursor=${URLEncoder.encode(it, "UTF-8")}" } ?: "")

internal data class SearchHit(
    val scope: String, val conversationKey: String, val conversationId: String, val title: String,
    val eventId: String, val eventCursor: Long?, val createdAt: String, val actor: String, val author: String,
    val snippet: String, val highlights: List<IntRange>,
) {
    val isRoom get() = scope == "room"
    val id get() = "$conversationKey/$eventId"
}

internal data class SearchPage(val hits: List<SearchHit>, val nextCursor: String?, val truncated: Boolean)

/**
 * Highlight spans as inclusive index ranges into [snippet]. The server's `{start,length}` are UTF-16
 * code-unit offsets, which are Kotlin `String` indices; spans outside the snippet are cut or dropped,
 * and overlapping or touching spans merge.
 */
internal fun highlightRanges(snippet: String, spans: List<Pair<Int, Int>>): List<IntRange> {
    val clamped = spans.mapNotNull { (start, length) ->
        if (start < 0 || length <= 0 || start >= snippet.length) null else start until minOf(snippet.length, start + length)
    }.sortedBy { it.first }
    val merged = mutableListOf<IntRange>()
    for (range in clamped) {
        val last = merged.lastOrNull()
        if (last != null && range.first <= last.last + 1) merged[merged.lastIndex] = last.first..maxOf(last.last, range.last) else merged.add(range)
    }
    return merged
}

internal fun parseSearchPage(response: JSONObject): SearchPage {
    val results = response.optJSONArray("results")
    val hits = (0 until (results?.length() ?: 0)).mapNotNull { results?.optJSONObject(it) }.mapNotNull { r ->
        val key = r.optString("conversation_key").takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val id = r.optString("conversation_id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val snippet = r.optString("snippet")
        val spans = r.optJSONArray("highlights")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { it.optInt("start", -1) to it.optInt("length", 0) } }.orEmpty()
        SearchHit(
            scope = r.optString("scope"), conversationKey = key, conversationId = id, title = r.optString("title"),
            eventId = r.optString("event_id"), eventCursor = if (r.has("event_cursor") && !r.isNull("event_cursor")) r.optLong("event_cursor").takeIf { it > 0 } else null,
            createdAt = r.optString("created_at"), actor = r.optString("actor"), author = r.optString("author"),
            snippet = snippet, highlights = highlightRanges(snippet, spans),
        )
    }
    return SearchPage(hits, response.optString("next_cursor").takeIf { it.isNotBlank() && it != "null" && !response.isNull("next_cursor") }, response.optBoolean("truncated"))
}

/** Older pages follow the newer ones; a hit seen twice keeps its first place. */
internal fun mergeSearchHits(old: List<SearchHit>, fresh: List<SearchHit>): List<SearchHit> = (old + fresh).distinctBy { it.id }

internal fun searchError(t: Texts, e: Throwable): String {
    if (e is ApiException) {
        if (e.status == 429 || e.code == "rate_limited") return e.retryAfterSeconds?.let { t.plural(R.plurals.search_rate_limited, it, it) } ?: t.string(R.string.search_rate_limited_soon)
        return e.message?.takeIf { it.isNotBlank() } ?: t.string(R.string.search_failed)
    }
    return t.string(R.string.search_failed)
}
