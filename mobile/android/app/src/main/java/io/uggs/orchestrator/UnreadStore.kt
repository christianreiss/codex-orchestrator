package io.uggs.orchestrator

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Reply cursors only: neither message text nor credentials belong in read state. */
internal class ReplyUnreadLedger(json: JSONObject = JSONObject()) {
    private data class Entry(var read: Long = 0, var latest: Long = 0, val pending: MutableSet<String> = linkedSetOf())
    private val entries = linkedMapOf<String, Entry>()
    init {
        val sessions = json.optJSONObject("sessions") ?: JSONObject()
        for (id in sessions.keys()) {
            val row = sessions.optJSONObject(id) ?: continue
            entries[id] = Entry(row.optLong("read").coerceAtLeast(0), row.optLong("latest").coerceAtLeast(0),
                row.optJSONArray("pending")?.strings()?.take(200)?.toMutableSet() ?: linkedSetOf())
        }
    }
    fun observe(cursors: Map<String, Long?>, pruneMissing: Boolean = true) {
        if (pruneMissing) entries.keys.retainAll(cursors.keys)
        for ((id, cursor) in cursors) {
            if (cursor != null && cursor >= 0) entries.getOrPut(id) { Entry() }.let {
                it.latest = maxOf(it.latest, cursor)
                // A stable authorized snapshot resolves pushes from older
                // servers/jobs that did not carry their source event cursor.
                if (pruneMissing) it.pending.clear()
            }
        }
    }
    fun push(id: String, cursor: Long?, notificationId: String): Boolean {
        if (id.isBlank() || id.length > 256 || notificationId.isBlank() || notificationId.length > 256) return false
        val entry = entries.getOrPut(id) { Entry() }
        if (cursor != null && cursor > 0) {
            if (cursor <= entry.read) return false
            entry.latest = maxOf(entry.latest, cursor)
        } else {
            if (entry.pending.size >= 200) entry.pending.remove(entry.pending.first())
            entry.pending.add(notificationId)
        }
        return entry.latest > entry.read || entry.pending.isNotEmpty()
    }
    fun read(id: String, cursor: Long) {
        if (cursor <= 0) return
        entries.getOrPut(id) { Entry() }.let {
            it.read = maxOf(it.read, cursor); it.latest = maxOf(it.latest, cursor)
            // Only a stable authorized snapshot can resolve a cursorless push:
            // it may have arrived after the reply currently visible in chat.
        }
    }
    fun unreadIds(): Set<String> = entries.filterValues { it.latest > it.read || it.pending.isNotEmpty() }.keys.toSet()
    fun latestCursor(id: String): Long? = entries[id]?.latest?.takeIf { it > 0 }
    fun json(): JSONObject = JSONObject().put("sessions", JSONObject().apply {
        for ((id, entry) in entries) put(id, JSONObject().put("read", entry.read).put("latest", entry.latest).put("pending", JSONArray(entry.pending.toList())))
    })
}

internal fun unreadScope(server: String, deviceId: String): String = MessageDigest.getInstance("SHA-256")
    .digest((server.trimEnd('/') + "\n" + deviceId).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

internal class UnreadStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    fun activate(connection: Connection) = synchronized(lock) {
        val scope = unreadScope(connection.server, connection.deviceId)
        if (prefs.getString("scope", null) != scope) {
            val next = prefs.getLong("revision", 0) + 1
            check(prefs.edit().clear().putString("scope", scope).putLong("revision", next).commit())
        }
    }
    private fun ledger() = ReplyUnreadLedger(runCatching { JSONObject(prefs.getString("state", "{}")!!) }.getOrDefault(JSONObject()))
    private fun save(ledger: ReplyUnreadLedger) {
        val value = ledger.json().toString()
        if (prefs.getString("state", "{}") != value) check(prefs.edit().putString("state", value).putLong("revision", prefs.getLong("revision", 0) + 1).commit())
    }
    fun revision(): Long = synchronized(lock) { prefs.getLong("revision", 0) }
    fun observeReplies(agents: List<JSONObject>, expectedRevision: Long? = null): Boolean = synchronized(lock) {
        val cursors = agents.filter { it.optString("id").isNotBlank() }.associate {
            it.getString("id") to if (it.has("reply_cursor") && !it.isNull("reply_cursor")) it.optLong("reply_cursor").coerceAtLeast(0) else null
        }
        val stable = expectedRevision == null || expectedRevision == prefs.getLong("revision", 0)
        val ledger = ledger(); ledger.observe(cursors, pruneMissing = stable); save(ledger); stable
    }
    fun observePush(sessionId: String, eventCursor: Long?, notificationId: String): Boolean = synchronized(lock) {
        val ledger = ledger(); val unread = ledger.push(sessionId, eventCursor, notificationId); save(ledger); unread
    }
    fun markRead(sessionId: String, replyCursor: Long) = synchronized(lock) {
        val ledger = ledger(); ledger.read(sessionId, replyCursor); save(ledger)
    }
    fun unreadIds(): Set<String> = synchronized(lock) { ledger().unreadIds() }
    fun latestCursor(sessionId: String): Long? = synchronized(lock) { ledger().latestCursor(sessionId) }
    fun clear() = synchronized(lock) {
        val next = prefs.getLong("revision", 0) + 1
        check(prefs.edit().clear().putLong("revision", next).commit())
    }
    companion object {
        const val PREFERENCES = "unread-replies"
        private val lock = Any()
    }
}
