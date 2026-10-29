package io.uggs.orchestrator

import org.json.JSONObject
import java.util.Base64

/*
 * Room delta sync, live activity and own-message rules (server R3 protocols). Pure, so the
 * merge, TTL and fallback rules are JVM-tested; RoomChats.kt does the I/O.
 */

/** Delta pages read in one sync before the app gives up and reads the room in full. */
internal const val ROOM_DELTA_MAX_PAGES = 10
/** `/rooms/changes` pages read in one refresh before it is treated like a resync. */
internal const val ROOM_CHANGES_MAX_PAGES = 10

/** Server protocol flags from `/me`; all off (today's behavior) for servers that omit them. */
internal data class RoomProtocols(val delta: Boolean = false, val notifications: Boolean = false, val actor: String? = null,
    /** R5: room reactions, pins and bounded message search (`reactions_protocol`, `pins_protocol`, `search_protocol`). */
    val reactions: Boolean = false, val pins: Boolean = false, val search: Boolean = false) {
    companion object {
        fun from(me: JSONObject) = RoomProtocols(
            delta = me.optInt("room_delta_protocol", 0) == 1,
            notifications = me.optInt("room_notifications_protocol", 0) == 1,
            actor = (me.opt("actor") as? String)?.takeIf { it.startsWith("admin:") && it.length in 7..128 },
            reactions = me.optInt("reactions_protocol", 0) == 1,
            pins = me.optInt("pins_protocol", 0) == 1,
            search = me.optInt("search_protocol", 0) == 1,
        )
    }
}

private val roomEventOrder = compareBy<JSONObject>({ it.optString("created_at") }, { it.optString("id") })

/**
 * Merges delta [fresh] events into the loaded timeline [old] (oldest first). A known id is
 * replaced (receipt updates carry current `deliveries`); a new event is added, unless older
 * history exists ([hasEarlier]) and it sorts before the first loaded event: that would
 * open an invisible gap, and the event is loaded with "Earlier messages" instead.
 */
internal fun mergeRoomDelta(old: List<JSONObject>, fresh: List<JSONObject>, hasEarlier: Boolean): List<JSONObject> {
    val first = old.minWithOrNull(roomEventOrder)
    val byId = LinkedHashMap<String, JSONObject>()
    old.forEach { byId[it.getString("id")] = it }
    fresh.forEach { event ->
        val id = event.optString("id").takeIf { it.isNotBlank() } ?: return@forEach
        if (id in byId || !hasEarlier || first == null || roomEventOrder.compare(event, first) >= 0) byId[id] = event
    }
    return byId.values.sortedWith(roomEventOrder)
}

/**
 * The `/rooms/read` history cursor for events before [oldest]: the server's own `next_before`
 * format (base64url JSON `{time,id}` of the page's oldest event, see agent-room-chat `read`).
 * Used when a room opens from its delta-synced cache, which has no server cursor.
 */
internal fun roomHistoryCursor(oldest: JSONObject): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(
        JSONObject().put("time", oldest.getString("created_at")).put("id", oldest.getString("id")).toString().toByteArray(Charsets.UTF_8))

/** One working member of a `room_activity` frame. */
internal data class RoomActivityActor(val addressId: String, val name: String, val state: String)
/** Live activity of one room, valid until [expiresAt] (`elapsedRealtime`). Never persisted. */
internal data class RoomActivity(val actors: List<RoomActivityActor>, val expiresAt: Long)

/** Applies a frame: `actors:[]` or `ttl_s:0` clears the room; otherwise it lasts `ttl_s` from [now]. */
internal fun applyRoomActivity(current: Map<String, RoomActivity>, roomId: String, actors: List<RoomActivityActor>, ttlSeconds: Int, now: Long): Map<String, RoomActivity> {
    val pruned = current.filterValues { it.expiresAt > now }
    return if (actors.isEmpty() || ttlSeconds <= 0) pruned - roomId
    else pruned + (roomId to RoomActivity(actors, now + ttlSeconds.coerceAtMost(60) * 1000L))
}

/** Actors still working in [roomId] at [now]; an expired frame counts as cleared. */
internal fun activeRoomActors(current: Map<String, RoomActivity>, roomId: String, now: Long): List<RoomActivityActor> =
    current[roomId]?.takeIf { it.expiresAt > now }?.actors.orEmpty()

/**
 * Whether a room event is this operator's own message. The local bubble of an unconfirmed send
 * (`admin:local`) always is; with the `/me` [selfActor] only that exact actor is (another
 * admin's message is not); without it (older server) every `admin:` actor counts, as before.
 */
internal fun isOwnRoomActor(actor: String?, selfActor: String?): Boolean = when {
    actor == "admin:local" -> true
    selfActor != null -> actor == selfActor
    else -> actor?.startsWith("admin:") == true
}
