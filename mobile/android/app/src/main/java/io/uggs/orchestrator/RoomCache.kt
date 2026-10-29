package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject

/**
 * Offline copy of the room directory (active view, first loaded rows) and the
 * newest [MAX_EVENTS] events of recently read rooms, so rooms render at cold
 * start and without a connection until the server answers. Confirmed server
 * rows only: cached rows confer no live presence (members restore as not
 * reachable) and are marked `cached`. Room content is only kept while
 * `agent_messaging.reveal_content` is granted ([stripContent] otherwise).
 *
 * Delta sync (`room_delta_protocol` 1) keeps each timeline's `next_after` change cursor and
 * whether older history exists beside its events, plus the `/rooms/changes` cursor. All are
 * optional fields of version 1: a cache written before them simply has no cursor (full read).
 */
internal class RoomHistoryCache(private val owner: String, saved: String? = null) {
    companion object {
        const val VERSION = 1
        const val MAX_ROOMS = 200
        const val MAX_TIMELINES = 20
        const val MAX_EVENTS = 100
        const val MAX_BYTES = 2 * 1024 * 1024
        const val FILE = "room-cache.bin"

        private fun cachedRoom(room: JSONObject): JSONObject {
            val copy = JSONObject(room.toString()).put("cached", true)
            copy.optJSONArray("members")?.objects()?.forEach { it.put("reachable", false) }
            return copy
        }
    }

    private var directory: List<JSONObject> = emptyList()
    private val timelines = linkedMapOf<String, List<JSONObject>>()
    /** Delta cursor (`next_after`) per cached timeline; dropped with the timeline. */
    private val cursors = mutableMapOf<String, Long>()
    /** Timelines that may have events older than their first cached event. */
    private val earlier = mutableSetOf<String>()
    /** Pinned event ids (newest first) per cached timeline; dropped with the timeline. */
    private val pins = mutableMapOf<String, List<String>>()
    /** `/rooms/changes` cursor; null until the first change listing. */
    var changesAfter: Long? = null

    init {
        runCatching {
            val document = saved?.takeIf { it.toByteArray(Charsets.UTF_8).size <= MAX_BYTES }?.let(::JSONObject)
            if (document != null && document.optInt("version") == VERSION && owner.isNotBlank() && document.optString("owner") == owner) {
                directory = document.getJSONArray("rooms").objects().filter { it.optString("id").isNotBlank() }
                val stored = document.getJSONArray("timelines")
                for (i in 0 until stored.length()) {
                    val entry = stored.getJSONObject(i)
                    val events = entry.getJSONArray("events").objects().filter { it.optString("id").isNotBlank() }
                    val id = entry.getString("room_id")
                    if (events.isNotEmpty()) {
                        timelines[id] = events.takeLast(MAX_EVENTS)
                        entry.optLong("after", -1).takeIf { it >= 0 && entry.has("after") }?.let { cursors[id] = it }
                        if (entry.optBoolean("earlier") || events.size > MAX_EVENTS) earlier.add(id)
                        entry.optJSONArray("pinned")?.let { p -> pins[id] = (0 until p.length()).mapNotNull { (p.opt(it) as? String)?.takeIf(String::isNotBlank) } }
                    }
                }
                changesAfter = document.optLong("changes_after", -1).takeIf { it >= 0 && document.has("changes_after") }
                trim()
            }
        }.onFailure { directory = emptyList(); timelines.clear(); cursors.clear(); earlier.clear(); pins.clear(); changesAfter = null }
    }

    val isEmpty get() = directory.isEmpty() && timelines.isEmpty()
    fun rooms(): List<JSONObject> = directory.map(::cachedRoom)
    fun events(roomId: String): List<JSONObject> = timelines[roomId]?.map { JSONObject(it.toString()) } ?: emptyList()

    fun rememberRooms(rooms: List<JSONObject>) {
        directory = rooms.take(MAX_ROOMS).map { JSONObject(it.toString()) }
        trim()
    }

    /**
     * Keeps the newest events of [roomId]; it becomes the most recently used room. [after] is the
     * delta cursor these events are current to (null keeps none); [hasEarlier] whether older
     * history exists before them (also true when the tail was cut here).
     */
    fun rememberEvents(roomId: String, events: List<JSONObject>, after: Long? = null, hasEarlier: Boolean = false) {
        timelines.remove(roomId); cursors.remove(roomId); earlier.remove(roomId)
        val tail = events.takeLast(MAX_EVENTS).map { JSONObject(it.toString()) }
        if (tail.isNotEmpty()) {
            timelines[roomId] = tail
            after?.let { cursors[roomId] = it }
            if (hasEarlier || events.size > tail.size) earlier.add(roomId)
        }
        trim()
    }
    fun after(roomId: String): Long? = cursors[roomId]?.takeIf { roomId in timelines }
    fun hasEarlier(roomId: String): Boolean = roomId in earlier
    /** Remembers the room's pinned event ids; only for a room whose timeline is cached. */
    fun rememberPinned(roomId: String, pinned: List<String>) { if (roomId in timelines) pins[roomId] = pinned }
    fun pinned(roomId: String): List<String> = if (roomId in timelines) pins[roomId].orEmpty() else emptyList()

    fun forget(roomId: String) { timelines.remove(roomId); cursors.remove(roomId); earlier.remove(roomId); pins.remove(roomId) }
    /** Drops every room's content, keeping only the directory (and the directory's change cursor). */
    fun stripContent() { timelines.clear(); cursors.clear(); earlier.clear(); pins.clear() }
    fun clear() { directory = emptyList(); timelines.clear(); cursors.clear(); earlier.clear(); pins.clear(); changesAfter = null }

    fun json(): String = JSONObject().put("version", VERSION).put("owner", owner)
        .put("rooms", JSONArray(directory))
        .put("timelines", JSONArray(timelines.map { (id, events) -> JSONObject().put("room_id", id).put("events", JSONArray(events))
            .apply { cursors[id]?.let { put("after", it) }; if (id in earlier) put("earlier", true); pins[id]?.takeIf { it.isNotEmpty() }?.let { put("pinned", JSONArray(it)) } } }))
        .apply { changesAfter?.let { put("changes_after", it) } }
        .toString()

    /** Over budget, the least recently read room loses half its events, then whole rooms go, then directory rows. */
    private fun trim() {
        while (timelines.size > MAX_TIMELINES) forget(timelines.keys.first())
        while (!isEmpty && json().toByteArray(Charsets.UTF_8).size > MAX_BYTES) {
            if (timelines.isNotEmpty()) {
                val oldest = timelines.keys.first()
                val events = timelines.getValue(oldest)
                if (timelines.size > 1 || events.size <= 1) forget(oldest)
                else { timelines[oldest] = events.drop(events.size / 2); earlier.add(oldest) }
            } else directory = directory.dropLast(maxOf(1, directory.size / 2))
        }
    }
}
