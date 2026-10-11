package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Confirmed server events only. Cached rows never confer live permissions or unread state. */
internal class ChatHistoryCache(private val owner: String, saved: String? = null) {
    companion object {
        const val MAX_CHATS = 20
        const val MAX_EVENTS = 500
        const val MAX_BYTES = 4 * 1024 * 1024
        private val cachedTypes = setOf("user_message", "assistant_message", "message_accepted", "message_read", "message_processing", "message_canceled", "failed")

        fun owner(connection: Connection): String = MessageDigest.getInstance("SHA-256")
            .digest("${connection.server.trimEnd('/')}\u0000${connection.deviceId}\u0000${connection.token}".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

        private fun active(agent: JSONObject) = !isClosedAgent(agent) && !agent.optBoolean("read_only")

        private fun card(agent: JSONObject): JSONObject {
            val saved = JSONObject()
            for (key in listOf("id", "engine", "host", "cwd", "session_name", "task_title", "launch_name",
                "upstream_session_id", "daemon_session", "portal_session_id", "remote_status", "last_event_at", "preview")) {
                if (agent.has(key)) saved.put(key, agent.get(key))
            }
            return saved.put("presence", "idle").put("relay_ready", false).put("cached", true)
                .put("activity", JSONObject().put("state", "unknown"))
        }
    }

    private val chats = linkedMapOf<String, JSONObject>()
    init {
        runCatching {
            val document = saved?.takeIf { it.toByteArray(Charsets.UTF_8).size <= MAX_BYTES }?.let(::JSONObject)
            if (document?.optInt("version") == 1 && document.optString("owner") == owner) {
                val entries = document.getJSONArray("chats")
                for (i in 0 until entries.length()) {
                    val entry = entries.getJSONObject(i)
                    remember(entry.getJSONObject("agent"), entry.getJSONArray("events").objects(), entry.optLong("cursor"))
                }
            }
        }.onFailure { chats.clear() }
    }

    fun agents(): List<JSONObject> = chats.values.map { JSONObject(it.getJSONObject("agent").toString()) }
    fun events(id: String): List<JSONObject> = chats[id]?.getJSONArray("events")?.objects()
        ?.map { JSONObject(it.toString()) } ?: emptyList()
    fun cursor(id: String): Long = chats[id]?.optLong("cursor") ?: 0

    fun reconcile(agents: List<JSONObject>) {
        val active = agents.filter(::active).associateBy { it.optString("id") }
        chats.keys.retainAll(active.keys)
        chats.forEach { (id, entry) -> entry.put("agent", card(active.getValue(id))) }
        trim()
    }

    fun remember(agent: JSONObject, events: List<JSONObject>, cursor: Long = 0) {
        val id = agent.optString("id")
        if (id.isBlank()) return
        if (!active(agent)) { chats.remove(id); return }
        val confirmed = mergeChatEvents(emptyList(), events).filter { it.optString("type") in cachedTypes }.takeLast(MAX_EVENTS)
        if (confirmed.isEmpty()) { chats.remove(id); return }
        chats.remove(id)
        chats[id] = JSONObject().put("agent", card(agent)).put("events", JSONArray(confirmed))
            .put("cursor", maxOf(cursor, events.maxOfOrNull { it.optLong("cursor") } ?: 0))
        trim()
    }

    fun remove(id: String) { chats.remove(id) }
    fun clear() { chats.clear() }
    fun json(): String = JSONObject().put("version", 1).put("owner", owner)
        .put("chats", JSONArray(chats.values.toList())).toString()

    private fun trim() {
        while (chats.size > MAX_CHATS) chats.remove(chats.keys.first())
        while (chats.isNotEmpty() && json().toByteArray(Charsets.UTF_8).size > MAX_BYTES) {
            val oldest = chats.keys.first()
            val events = chats.getValue(oldest).getJSONArray("events").objects()
            if (chats.size > 1 || events.size <= 1) chats.remove(oldest)
            else chats.getValue(oldest).put("events", JSONArray(events.drop(events.size / 2)))
        }
    }
}

/** A server replay replaces the cached row with the same cursor. Local send bubbles stay separate. */
internal fun mergeChatEvents(cached: List<JSONObject>, incoming: List<JSONObject>): List<JSONObject> {
    val byCursor = linkedMapOf<Long, JSONObject>()
    for (event in cached + incoming) {
        val cursor = event.optLong("cursor")
        if (cursor > 0) byCursor[cursor] = event
    }
    return byCursor.toSortedMap().values.toList()
}
