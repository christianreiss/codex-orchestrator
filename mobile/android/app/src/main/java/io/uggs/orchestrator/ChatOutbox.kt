package io.uggs.orchestrator

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject

/**
 * One send the server has not confirmed. [body] is the request body frozen
 * when the operator tapped send: every retry, also after a restart, POSTs
 * exactly these bytes with the same id (`client_message_id` for direct chats,
 * `client_request_id` for rooms), so the server deduplicates it.
 */
internal data class OutboxEntry(
    val id: String,
    /** [ConversationKey.storageKey] of the conversation. */
    val conversation: String,
    val path: String,
    val body: String,
    val createdAt: String,
    /** A definitive rejection: never retried automatically, only by an explicit retry. */
    val failed: Boolean = false,
    val error: String? = null,
    val attempts: Int = 0,
    /** `elapsedRealtime` of the next automatic attempt. Not persisted: a restart retries at once. */
    val nextAttemptAt: Long = 0,
) {
    val room get() = conversation.startsWith(ConversationKey.ROOM_PREFIX)

    fun json(): JSONObject = JSONObject().put("id", id).put("conversation", conversation).put("path", path)
        .put("body", body).put("created_at", createdAt).put("failed", failed).put("attempts", attempts)
        .apply { error?.let { put("error", it) } }

    companion object {
        fun parse(json: JSONObject): OutboxEntry? = runCatching {
            val body = json.getString("body")
            JSONObject(body) // Must still be a valid request.
            OutboxEntry(json.getString("id").also { require(it.isNotBlank()) }, json.getString("conversation").also { require(it.isNotBlank()) },
                json.getString("path").also { require(it.startsWith("/")) }, body, json.optString("created_at"),
                json.optBoolean("failed"), json.optString("error").takeIf { it.isNotBlank() && json.has("error") }, json.optInt("attempts"))
        }.getOrNull()
    }
}

/** Composer state of one conversation: text and the message it answers (Portal cursor or room event id). */
internal data class ChatDraft(val text: String, val replyTo: String? = null)

internal enum class SendFailure { Transient, Definitive }

/** A 4xx other than 408/429 is the server's final answer; network errors, 5xx, 408 and 429 are worth retrying. */
internal fun classifySendFailure(error: Throwable): SendFailure =
    if (error is ApiException && error.status in 400..499 && error.status != 408 && error.status != 429) SendFailure.Definitive else SendFailure.Transient

internal const val OUTBOX_FIRST_RETRY_MS = 30_000L
internal const val OUTBOX_MAX_RETRY_MS = 5 * 60_000L

/** Automatic retries back off from 30 s, doubling, to five minutes. [attempts] counts failed tries so far. */
internal fun outboxRetryDelay(attempts: Int): Long =
    (OUTBOX_FIRST_RETRY_MS shl (attempts - 1).coerceIn(0, 4)).coerceAtMost(OUTBOX_MAX_RETRY_MS)

internal sealed interface OutboxResult {
    data class Accepted(val response: JSONObject) : OutboxResult
    data class Rejected(val error: Exception, val failure: SendFailure) : OutboxResult
}

/** One attempt: the frozen body, byte for byte. */
internal suspend fun deliverOutboxEntry(client: Api, entry: OutboxEntry): OutboxResult = try {
    OutboxResult.Accepted(client.post(entry.path, entry.body))
} catch (e: CancellationException) { throw e }
catch (e: Exception) { OutboxResult.Rejected(e, classifySendFailure(e)) }

/** The entry after an attempt failed: definitive rejections stop, transient ones wait for the next backoff step. */
internal fun OutboxEntry.afterFailure(result: OutboxResult.Rejected, now: Long): OutboxEntry =
    if (result.failure == SendFailure.Definitive) copy(failed = true, error = result.error.message, nextAttemptAt = 0)
    else copy(attempts = attempts + 1, error = result.error.message, nextAttemptAt = now + outboxRetryDelay(attempts + 1))

/**
 * Unconfirmed sends and composer drafts of one paired account (direct chats
 * and rooms), persisted as one encrypted blob. Observable for Compose.
 *
 * Budget: at most [MAX_ENTRIES] sends, [MAX_DRAFTS] drafts and [MAX_BYTES]
 * serialized. Over budget, the least recently edited drafts go first, then
 * definitively failed sends, and only then the oldest unconfirmed sends.
 * Unreadable, foreign (other pairing) or other-version data restores as empty.
 */
internal class ChatOutbox(owner: String = "", saved: String? = null) {
    companion object {
        const val VERSION = 1
        const val MAX_ENTRIES = 50
        const val MAX_DRAFTS = 100
        const val MAX_BYTES = 1024 * 1024
        const val FILE = "chat-outbox.bin"
    }

    var owner = owner; private set
    var entries by mutableStateOf<List<OutboxEntry>>(emptyList()); private set
    /** Insertion order is edit order: the oldest edit is trimmed first. */
    var drafts by mutableStateOf<Map<String, ChatDraft>>(emptyMap()); private set
    /** Counts wipes, so a restore that started before one does not bring wiped content back. */
    var wipes = 0L; private set
    var onChange: (() -> Unit)? = null

    init { if (saved != null) restore(owner, saved) }

    /** Adds saved state under the same owner; anything already in memory wins. Malformed data is ignored. */
    fun restore(owner: String, saved: String?) {
        if (owner != this.owner) { reset(owner) }
        val (savedEntries, savedDrafts) = runCatching {
            val document = saved?.takeIf { it.toByteArray(Charsets.UTF_8).size <= MAX_BYTES }?.let(::JSONObject)
            if (document == null || document.optInt("version") != VERSION || document.optString("owner") != owner || owner.isBlank()) return
            val stored = document.optJSONArray("entries") ?: JSONArray()
            val parsed = (0 until stored.length()).mapNotNull { stored.optJSONObject(it)?.let(OutboxEntry::parse) }.distinctBy { it.id }
            val drafts = linkedMapOf<String, ChatDraft>()
            document.optJSONObject("drafts")?.let { map ->
                // JSONObject loses order; the saved list keeps it.
                val order = document.optJSONArray("draft_order")?.let { list -> (0 until list.length()).mapNotNull { list.opt(it) as? String } }
                    ?: map.keys().asSequence().toList()
                order.forEach { key ->
                    val draft = map.optJSONObject(key) ?: return@forEach
                    drafts[key] = ChatDraft(draft.optString("text"), draft.optString("reply_to").takeIf { it.isNotBlank() && draft.has("reply_to") })
                }
            }
            parsed to drafts
        }.getOrElse { return }
        entries = savedEntries.filter { saved -> entries.none { it.id == saved.id } } + entries
        drafts = LinkedHashMap(savedDrafts.filterKeys { it !in drafts }).apply { putAll(drafts) }
        trim(); changed()
    }

    /** Drops everything and binds the outbox to [owner] (a new pairing). */
    fun reset(owner: String) { this.owner = owner; clear() }

    fun entry(id: String) = entries.firstOrNull { it.id == id }
    fun entries(conversation: String) = entries.filter { it.conversation == conversation }

    /** Persists a new send; call before the network request. Replaces an entry with the same id. */
    fun enqueue(entry: OutboxEntry) { entries = entries.filterNot { it.id == entry.id } + entry; trim(); changed() }
    fun update(id: String, transform: (OutboxEntry) -> OutboxEntry) {
        if (entries.none { it.id == id }) return
        entries = entries.map { if (it.id == id) transform(it) else it }; trim(); changed()
    }
    fun remove(id: String) { if (entries.any { it.id == id }) { entries = entries.filterNot { it.id == id }; changed() } }
    /** Marks all automatic retries due now, e.g. when connectivity returns. */
    fun retryNow() { if (entries.any { it.nextAttemptAt > 0 }) entries = entries.map { it.copy(nextAttemptAt = 0) } }

    fun draft(key: String?): ChatDraft? = key?.let { drafts[it] }
    fun setDraft(key: String, text: String, replyTo: String?) {
        val value = ChatDraft(text, replyTo)
        if (drafts[key] == value || (drafts[key] == null && text.isEmpty() && replyTo == null)) return
        drafts = LinkedHashMap(drafts).apply { remove(key); if (text.isNotEmpty() || replyTo != null) put(key, value) }
        trim(); changed()
    }

    fun clear() { wipes++; val had = entries.isNotEmpty() || drafts.isNotEmpty(); entries = emptyList(); drafts = emptyMap(); if (had) changed() }
    /** Wipes sends (and, with [drafts], drafts) of the conversations matching [match]. */
    fun clearWhere(drafts: Boolean = true, match: (String) -> Boolean) {
        wipes++
        val keptEntries = entries.filterNot { match(it.conversation) }
        val keptDrafts = if (drafts) this.drafts.filterKeys { !match(it) } else this.drafts
        if (keptEntries.size == entries.size && keptDrafts.size == this.drafts.size) return
        entries = keptEntries; this.drafts = LinkedHashMap(keptDrafts); changed()
    }

    val isEmpty get() = entries.isEmpty() && drafts.isEmpty()

    /** The blob, or null when nothing is left to keep (the file is deleted). */
    fun json(): String? = if (isEmpty) null else document().toString()

    private fun document() = JSONObject().put("version", VERSION).put("owner", owner)
        .put("entries", JSONArray(entries.map { it.json() }))
        .put("drafts", JSONObject().apply { drafts.forEach { (key, draft) -> put(key, JSONObject().put("text", draft.text).apply { draft.replyTo?.let { put("reply_to", it) } }) } })
        .put("draft_order", JSONArray(drafts.keys.toList()))

    private fun size() = document().toString().toByteArray(Charsets.UTF_8).size

    private fun trim() {
        while (entries.size > MAX_ENTRIES) dropEntry()
        if (drafts.size > MAX_DRAFTS) drafts = LinkedHashMap(drafts.entries.drop(drafts.size - MAX_DRAFTS).associate { it.key to it.value })
        while (!isEmpty && size() > MAX_BYTES) {
            if (drafts.isNotEmpty()) drafts = LinkedHashMap(drafts).apply { remove(keys.first()) } else dropEntry()
        }
    }

    private fun dropEntry() {
        val victim = entries.firstOrNull { it.failed } ?: entries.first()
        entries = entries.filterNot { it === victim }
    }

    private fun changed() { onChange?.invoke() }
}
