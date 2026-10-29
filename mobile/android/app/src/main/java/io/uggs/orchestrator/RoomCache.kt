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

    init {
        runCatching {
            val document = saved?.takeIf { it.toByteArray(Charsets.UTF_8).size <= MAX_BYTES }?.let(::JSONObject)
            if (document != null && document.optInt("version") == VERSION && owner.isNotBlank() && document.optString("owner") == owner) {
                directory = document.getJSONArray("rooms").objects().filter { it.optString("id").isNotBlank() }
                val stored = document.getJSONArray("timelines")
                for (i in 0 until stored.length()) {
                    val entry = stored.getJSONObject(i)
                    val events = entry.getJSONArray("events").objects().filter { it.optString("id").isNotBlank() }
                    if (events.isNotEmpty()) timelines[entry.getString("room_id")] = events.takeLast(MAX_EVENTS)
                }
                trim()
            }
        }.onFailure { directory = emptyList(); timelines.clear() }
    }

    val isEmpty get() = directory.isEmpty() && timelines.isEmpty()
    fun rooms(): List<JSONObject> = directory.map(::cachedRoom)
    fun events(roomId: String): List<JSONObject> = timelines[roomId]?.map { JSONObject(it.toString()) } ?: emptyList()

    fun rememberRooms(rooms: List<JSONObject>) {
        directory = rooms.take(MAX_ROOMS).map { JSONObject(it.toString()) }
        trim()
    }

    /** Keeps the newest events of [roomId]; it becomes the most recently used room. */
    fun rememberEvents(roomId: String, events: List<JSONObject>) {
        timelines.remove(roomId)
        val tail = events.takeLast(MAX_EVENTS).map { JSONObject(it.toString()) }
        if (tail.isNotEmpty()) timelines[roomId] = tail
        trim()
    }

    fun forget(roomId: String) { timelines.remove(roomId) }
    /** Drops every room's content, keeping only the directory. */
    fun stripContent() { timelines.clear() }
    fun clear() { directory = emptyList(); timelines.clear() }

    fun json(): String = JSONObject().put("version", VERSION).put("owner", owner)
        .put("rooms", JSONArray(directory))
        .put("timelines", JSONArray(timelines.map { (id, events) -> JSONObject().put("room_id", id).put("events", JSONArray(events)) }))
        .toString()

    /** Over budget, the least recently read room loses half its events, then whole rooms go, then directory rows. */
    private fun trim() {
        while (timelines.size > MAX_TIMELINES) timelines.remove(timelines.keys.first())
        while (!isEmpty && json().toByteArray(Charsets.UTF_8).size > MAX_BYTES) {
            if (timelines.isNotEmpty()) {
                val oldest = timelines.keys.first()
                val events = timelines.getValue(oldest)
                if (timelines.size > 1 || events.size <= 1) timelines.remove(oldest)
                else timelines[oldest] = events.drop(events.size / 2)
            } else directory = directory.dropLast(maxOf(1, directory.size / 2))
        }
    }
}
