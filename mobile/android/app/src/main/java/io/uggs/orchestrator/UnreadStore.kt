package io.uggs.orchestrator

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Reply cursors and counts only: neither message text nor credentials belong in read state. */
internal class ReplyUnreadLedger(json: JSONObject = JSONObject()) {
    private data class Entry(var read: Long = 0, var latest: Long = 0, var count: Int = 0, val pending: MutableSet<String> = linkedSetOf(), var closed: Boolean = false, var settled: Long = 0)
    private val entries = linkedMapOf<String, Entry>()
    init {
        val sessions = json.optJSONObject("sessions") ?: JSONObject()
        for (id in sessions.keys()) {
            val row = sessions.optJSONObject(id) ?: continue
            val read = row.optLong("read").coerceAtLeast(0)
            val latest = row.optLong("latest").coerceAtLeast(0)
            entries[id] = Entry(read, latest, row.optInt("count", if (latest > read) 1 else 0).coerceAtLeast(0),
                row.optJSONArray("pending")?.strings()?.take(200)?.toMutableSet() ?: linkedSetOf(), row.optBoolean("closed"), row.optLong("settled", 0).coerceAtLeast(0))
        }
    }
    fun observe(cursors: Map<String, Long?>, pruneMissing: Boolean = true, counts: Map<String, Int> = emptyMap(), closedIds: Set<String> = emptySet()) {
        if (pruneMissing) entries.keys.retainAll(cursors.keys)
        for ((id, cursor) in cursors) {
            if (pruneMissing && id in closedIds) {
                entries.getOrPut(id) { Entry() }.let {
                    it.closed = true; it.count = 0; it.pending.clear()
                    it.latest = maxOf(it.latest, cursor ?: 0)
                }
                continue
            }
            if (entries[id]?.closed == true) {
                if (!pruneMissing) continue
                entries.getValue(id).closed = false
            }
            if (cursor != null && cursor >= 0) entries.getOrPut(id) { Entry() }.let {
                if (cursor > it.latest && cursor > it.read) it.count = maxOf(it.count, 1)
                it.latest = maxOf(it.latest, cursor)
                if (pruneMissing && id in counts) it.count = counts.getValue(id).coerceAtLeast(0)
                if (it.latest <= it.read) it.count = 0
                // A stable authorized snapshot resolves pushes from older
                // servers/jobs that did not carry their source event cursor.
                if (pruneMissing) it.pending.clear()
            }
        }
    }
    fun push(id: String, cursor: Long?, notificationId: String): Boolean {
        if (id.isBlank() || id.length > 256 || notificationId.isBlank() || notificationId.length > 256) return false
        val entry = entries.getOrPut(id) { Entry() }
        if (entry.closed) return false
        if (cursor != null && cursor > 0) {
            if (cursor <= entry.read) return false
            if (cursor > entry.latest) entry.count = (entry.count.toLong() + 1).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            entry.latest = maxOf(entry.latest, cursor)
        } else {
            if (entry.pending.size >= 200) entry.pending.remove(entry.pending.first())
            entry.pending.add(notificationId)
        }
        return entry.count > 0 || entry.pending.isNotEmpty()
    }
    fun read(id: String, cursor: Long) {
        if (cursor <= 0) return
        entries.getOrPut(id) { Entry() }.let {
            it.read = maxOf(it.read, cursor); it.latest = maxOf(it.latest, cursor)
            if (it.read >= it.latest) it.count = 0
            // Only a stable authorized snapshot can resolve a cursorless push:
            // it may have arrived after the reply currently visible in chat.
        }
    }
    fun sharedReads(cursors: Map<String, Long>) {
        for ((id, cursor) in cursors) if (id.isNotBlank() && cursor > 0) {
            read(id, cursor)
            entries.getValue(id).let { it.settled = maxOf(it.settled, cursor) }
        }
    }
    fun settle(cursors: Map<String, Long>) {
        for ((id, cursor) in cursors) entries[id]?.let { it.settled = maxOf(it.settled, minOf(it.read, cursor)) }
    }
    fun hasPendingReads() = entries.values.any { it.read > it.settled }
    fun readCursor(id: String): Long = entries[id]?.read ?: 0
    fun unreadIds(): Set<String> = entries.filterValues { !it.closed && (it.count > 0 || it.pending.isNotEmpty()) }.keys.toSet()
    fun unreadReplyCount(id: String): Int = entries[id]?.let {
        if (it.closed) 0 else (it.count.toLong() + it.pending.size).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    } ?: 0
    fun readCursors(pendingOnly: Boolean = false): Map<String, Long> {
        val eligible = entries.filterValues { it.read > 0 && (!pendingOnly || it.read > it.settled) }.toList()
        return (if (pendingOnly) eligible.take(500) else eligible.takeLast(500)).toMap().mapValues { it.value.read }
    }
    fun latestCursor(id: String): Long? = entries[id]?.latest?.takeIf { it > 0 }
    fun json(): JSONObject = JSONObject().put("sessions", JSONObject().apply {
        for ((id, entry) in entries) put(id, JSONObject().put("read", entry.read).put("latest", entry.latest).put("count", entry.count).put("pending", JSONArray(entry.pending.toList())).put("closed", entry.closed).put("settled", entry.settled))
    })
}

internal fun unreadScope(server: String, deviceId: String): String = MessageDigest.getInstance("SHA-256")
    .digest((server.trimEnd('/') + "\n" + deviceId).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

internal class UnreadStore(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
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
    fun observeReplies(agents: List<JSONObject>, expectedRevision: Long? = null, processed: JSONObject? = null): Boolean = synchronized(lock) {
        val cursors = agents.filter { it.optString("id").isNotBlank() }.associate {
            it.getString("id") to if (it.has("reply_cursor") && !it.isNull("reply_cursor")) it.optLong("reply_cursor").coerceAtLeast(0) else null
        }
        val stable = expectedRevision == null || expectedRevision == prefs.getLong("revision", 0)
        val counts = agents.filter { it.has("unread_reply_count") && !it.isNull("unread_reply_count") }
            .associate { it.optString("id") to it.optInt("unread_reply_count").coerceAtLeast(0) }
        val closedIds = agents.filter(::isClosedAgent).map { it.optString("id") }.toSet()
        val ledger = ledger()
        // Shared receipts advance only the read watermark. They never consume a
        // newer local reply or let an old snapshot lower a device's position.
        if (processed != null) ledger.settle(processed.keys().asSequence().associateWith { processed.optLong(it, 0) })
        ledger.sharedReads(agents.associate { it.optString("id") to it.optLong("read_cursor", 0) })
        ledger.observe(cursors, pruneMissing = stable, counts = counts, closedIds = closedIds); save(ledger); stable
    }
    fun observeSharedRead(connection: Connection, sessionId: String, cursor: Long): Boolean = synchronized(lock) {
        val expected = unreadScope(connection.server, connection.deviceId)
        val current = ConnectionStore(appContext).load() ?: return@synchronized false
        if (prefs.getString("scope", null) != expected || unreadScope(current.server, current.deviceId) != expected) return@synchronized false
        val ledger = ledger(); ledger.sharedReads(mapOf(sessionId to cursor)); save(ledger); true
    }
    fun observePush(sessionId: String, eventCursor: Long?, notificationId: String): Boolean = synchronized(lock) {
        val ledger = ledger(); val unread = ledger.push(sessionId, eventCursor, notificationId); save(ledger); unread
    }
    fun markRead(sessionId: String, replyCursor: Long) = synchronized(lock) {
        val ledger = ledger(); ledger.read(sessionId, replyCursor); save(ledger)
    }
    fun unreadIds(): Set<String> = synchronized(lock) { ledger().unreadIds() }
    fun unreadReplyCount(sessionId: String): Int = synchronized(lock) { ledger().unreadReplyCount(sessionId) }
    fun readCursor(id: String): Long = synchronized(lock) { ledger().readCursor(id) }
    fun hasPendingReads(): Boolean = synchronized(lock) { ledger().hasPendingReads() }
    fun readCursors(pendingOnly: Boolean = false): JSONObject = synchronized(lock) { JSONObject(ledger().readCursors(pendingOnly)) }
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
