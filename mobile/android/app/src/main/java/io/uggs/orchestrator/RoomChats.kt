package io.uggs.orchestrator

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal fun roomLabel(room: JSONObject): String = when (room.optString("kind")) {
    "conference" -> "Conference"
    "project" -> "Project room"
    "host" -> "Host room"
    else -> "Group"
}
internal fun roomPersonLabel(person: JSONObject): String = listOf("name", "alias", "address").asSequence()
    .map { person.optString(it) }.firstOrNull { it.isNotBlank() && it != "null" } ?: "Unnamed agent"
/**
 * A room is active when a reachable member is also an online agent by the Chats
 * rules ([isOnlineActiveAgent]); the server's `reachable` only means a fresh
 * heartbeat. Without an agent overview (no transcript permission) the roster's
 * `reachable` flag is the only signal left.
 */
internal fun roomHasActiveAgent(room: JSONObject, agents: List<JSONObject>? = null): Boolean {
    val online = agents?.filter(::isOnlineActiveAgent)?.flatMap { listOf(it.optString("id"), it.optString("portal_session_id")) }?.filter { it.isNotBlank() && it != "null" }?.toSet()
    return room.optJSONArray("members")?.objects()?.any {
        it.optBoolean("reachable", false) && (online == null || it.optString("session_id") in online)
    } == true
}
/**
 * Live state of one room member by the same rules as [roomHasActiveAgent]:
 * `working`, `listening` or `idle` for an online agent, `offline` otherwise, and
 * `available` when only the roster's `reachable` flag is known (no agent overview).
 */
internal fun roomMemberPresence(member: JSONObject, agents: List<JSONObject>? = null): String {
    if (!member.optBoolean("reachable", false)) return "offline"
    if (agents == null) return "available"
    val session = member.optString("session_id").takeIf { it.isNotBlank() && it != "null" } ?: return "offline"
    val agent = agents.firstOrNull { it.optString("id") == session || it.optString("portal_session_id") == session }
    return if (agent != null && isOnlineActiveAgent(agent)) agent.optString("presence") else "offline"
}
/**
 * Where each agent stopped reading: a member is listed under the newest loaded event at or
 * before its server `read_through` time. Members that never read, or whose position lies
 * before the loaded history, have no marker. [events] must be sorted oldest first.
 */
internal fun roomReadMarkers(events: List<JSONObject>, members: List<JSONObject>): Map<String, List<JSONObject>> {
    val out = LinkedHashMap<String, MutableList<JSONObject>>()
    for (member in members) {
        val through = member.optString("read_through").takeIf { it.isNotBlank() && it != "null" } ?: continue
        val last = events.lastOrNull { it.optString("created_at") <= through } ?: continue
        out.getOrPut(last.getString("id")) { mutableListOf() }.add(member)
    }
    return out
}
/**
 * Who a room message asks. [Share] requests no answer; [AskAll] starts one
 * answer round with every participant; [Members] asks the chosen members.
 */
internal sealed interface RoomRecipients {
    data object Share : RoomRecipients
    data object AskAll : RoomRecipients
    data class Members(val ids: Set<String>) : RoomRecipients

    /** Toggling a member chip: the last removed member falls back to sharing. */
    fun toggle(id: String): RoomRecipients {
        val current = (this as? Members)?.ids.orEmpty()
        val next = if (id in current) current - id else current + id
        return if (next.isEmpty()) Share else Members(next)
    }
}

/** The `/rooms/send` body (strict server schema): `ask_all` and `recipients` never appear together. */
internal fun roomSendBody(roomId: String, requestId: String, content: String, attachments: List<String>, recipients: RoomRecipients, replyTo: String?): JSONObject =
    JSONObject().put("room_id", roomId).put("client_request_id", requestId).put("content", content).put("attachments", JSONArray(attachments)).apply {
        when (recipients) {
            RoomRecipients.Share -> Unit
            RoomRecipients.AskAll -> put("ask_all", true)
            is RoomRecipients.Members -> put("recipients", JSONArray(recipients.ids.sorted()))
        }
        replyTo?.takeIf { it.isNotBlank() }?.let { put("reply_to", it) }
    }

/** Recipients the operator can still ask: a chosen member who left or cannot answer is dropped. */
internal fun RoomRecipients.forMembers(members: List<JSONObject>): RoomRecipients {
    if (this !is RoomRecipients.Members) return this
    val askable = members.filter { it.optBoolean("reachable") && it.optBoolean("chat_capable") }.map { it.optString("id") }.toSet()
    val kept = ids.intersect(askable)
    return if (kept.isEmpty()) RoomRecipients.Share else RoomRecipients.Members(kept)
}

internal fun mergeRoomEvents(old: List<JSONObject>, fresh: List<JSONObject>): List<JSONObject> =
    (old + fresh).associateBy { it.getString("id") }.values.sortedWith(compareBy({ it.optString("created_at") }, { it.optString("id") }))

/**
 * The local bubble of an unconfirmed room send, shaped like a server room event of
 * this operator (`admin:` actor). It is drawn after the server events and never
 * joins `events`, so read markers and "seen" only ever see confirmed rows.
 * [status] is `sending`, `unconfirmed` or `failed`.
 */
internal fun roomLocalEvent(entry: OutboxEntry, status: String): JSONObject {
    val body = runCatching { JSONObject(entry.body) }.getOrDefault(JSONObject())
    return JSONObject().put("id", entry.id).put("room_id", body.optString("room_id")).put("kind", "chat").put("actor", "admin:local")
        .put("content", body.optString("content")).put("attachments", body.optJSONArray("attachments") ?: JSONArray())
        .put("created_at", entry.createdAt).put("local_send_id", entry.id).put("delivery_status", status)
        .apply { body.optString("reply_to").takeIf { it.isNotBlank() && body.has("reply_to") }?.let { put("reply_to", it) } }
}

/** A `/rooms/send` answer that is the stored room event itself (the server returns it, also for a deduplicated retry). */
private fun acceptedRoomEvent(response: JSONObject, roomId: String): JSONObject? =
    response.takeIf { it.optString("id").isNotBlank() && it.optString("created_at").isNotBlank() && it.has("kind") && (!it.has("room_id") || it.optString("room_id") == roomId) }

/** Shared room state stays separate from private Portal cursors and device follows. */
internal class RoomChats(
    private val scope: CoroutineScope,
    private val api: () -> Api,
    private val allowed: () -> Boolean,
    /** Unconfirmed sends and drafts, shared with direct chats; room entries use `room:<id>` keys. */
    private val outbox: ChatOutbox = ChatOutbox(),
    /** Called whenever the offline room cache changes; persist it. */
    private val cacheChanged: (RoomHistoryCache) -> Unit = {},
    /** Waits until the outbox is on disk; runs before every send attempt. */
    private val beforeSend: suspend () -> Unit = {},
    private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() },
    /** Pairing the offline cache belongs to ([ChatHistoryCache.owner]). */
    owner: String = "",
) {
    private var cache = RoomHistoryCache(owner)
    /** Counts content wipes, fencing a cache restore that started earlier. */
    var cacheWipes = 0L; private set
    private fun cacheUpdated() = cacheChanged(cache)
    private fun key(roomId: String) = ConversationKey.Room(roomId).storageKey
    private fun isRoomKey(key: String) = key.startsWith(ConversationKey.ROOM_PREFIX)
    var rooms by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var selected by mutableStateOf<String?>(null); private set
    var current by mutableStateOf<JSONObject?>(null); private set
    var events by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var nextBefore by mutableStateOf<String?>(null); private set
    var nextOffset by mutableStateOf<Int?>(null); private set
    var loading by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var supported by mutableStateOf(true); private set
    var enabled by mutableStateOf(true); private set
    var history by mutableStateOf(false); private set
    private fun directoryPath(offset: Int = 0) = "/rooms?view=${if (history) "history" else "active"}&offset=$offset"
    fun showHistory(value: Boolean) {
        if (history == value) return
        generation++; history = value; rooms = emptyList(); nextOffset = null; loading = false; error = null
    }
    var candidates by mutableStateOf<List<JSONObject>>(emptyList()); private set
    private var targets by mutableStateOf<Map<String, RoomRecipients>>(emptyMap())
    /** Newest chat event seen per room this session; the directory has no message preview. */
    var previews by mutableStateOf<Map<String, JSONObject>>(emptyMap()); private set
    private val frozenInitials = mutableMapOf<String, Map<String, String>>()
    /** Ids of sends with a request in flight. */
    private var sending by mutableStateOf<Set<String>>(emptySet())
    /** Persisted with the outbox, per room. */
    var draft: String
        get() = outbox.draft(selected?.let(::key))?.text.orEmpty()
        set(value) { selected?.let { outbox.setDraft(key(it), value, replyTo) } }
    var recipients: RoomRecipients
        get() = targets[selected] ?: RoomRecipients.Share
        set(value) { selected?.let { targets = targets + (it to value) } }
    /** Room event UUID the next message answers, persisted per room with the draft. */
    var replyTo: String?
        get() = outbox.draft(selected?.let(::key))?.replyTo
        set(value) { selected?.let { outbox.setDraft(key(it), draft, value) } }
    /** Avatar initials per member, frozen for this room for the session (see [freezeInitials]). */
    fun initials(roomId: String, members: List<JSONObject>): Map<String, String> {
        val names = members.associate { it.optString("id") to roomPersonLabel(it) }
        val previous = frozenInitials[roomId].orEmpty()
        if (previous.keys == names.keys) return previous
        return freezeInitials(previous, names).also { frozenInitials[roomId] = it }
    }
    /** Unconfirmed sends of the open room, oldest first. */
    val outgoing: List<OutboxEntry> get() = selected?.let { outbox.entries(key(it)) }.orEmpty()
    /** The oldest unconfirmed send of the open room: the composer retries it before sending anything new. */
    val pendingSend: OutboxEntry? get() = outgoing.firstOrNull()
    fun sendStatus(entry: OutboxEntry) = when {
        entry.id in sending -> "sending"
        entry.failed -> "failed"
        else -> "unconfirmed"
    }
    /** Local bubbles of [outgoing], drawn after the server events. */
    val localEvents: List<JSONObject> get() = outgoing.map { roomLocalEvent(it, sendStatus(it)) }
    private var generation = 0
    private var selection = 0
    private var operation by mutableStateOf<JSONObject?>(null)
    val pendingOperation get() = operation
    /** Sign-out, revocation or loss of room access: wipes the offline cache and room sends and drafts too. */
    fun clear() {
        generation++; selection++; rooms = emptyList(); selected = null; current = null
        events = emptyList(); targets = emptyMap(); previews = emptyMap(); frozenInitials.clear(); sending = emptySet()
        outbox.clearWhere(match = ::isRoomKey)
        cacheWipes++; cache.clear(); cacheUpdated()
        candidates = emptyList(); nextBefore = null; nextOffset = null; error = null
        loading = false; busy = false; operation = null; supported = true; enabled = true; history = false
    }
    /** A new pairing: nothing of the previous account's cache survives. */
    fun resetCache(owner: String) { cacheWipes++; cache = RoomHistoryCache(owner); cacheUpdated() }
    /**
     * Adopts the cache read from disk at cold start: rooms render before the
     * server answers. Live data loaded meanwhile wins.
     */
    fun restoreCache(restored: RoomHistoryCache) {
        if (!cache.isEmpty) return
        cache = restored
        cacheUpdated()
        if (rooms.isEmpty() && !history) rooms = restored.rooms()
        previews = rooms.mapNotNull { room ->
            val id = room.optString("id")
            restored.events(id).lastOrNull { it.optString("kind", "chat") == "chat" && it.optString("content").isNotBlank() }?.let { id to it }
        }.toMap() + previews
        selected?.let { id -> if (events.isEmpty()) events = restored.events(id) }
    }
    fun close() { selection++; selected = null; current = null; events = emptyList(); nextBefore = null; error = null; loading = false }
    suspend fun refresh(client: Api, caps: Set<String>, valid: () -> Boolean) {
        if ("agent_messaging.read" !in caps) { if (valid()) clear(); return }
        if ("agent_messaging.reveal_content" !in caps && valid()) {
            close(); previews = emptyMap()
            outbox.clearWhere(match = ::isRoomKey)
            cacheWipes++
            if (!cache.isEmpty) { cache.stripContent(); cacheUpdated() }
        }
        val epoch = generation
        val page = try { client.request(directoryPath()) } catch (e: ApiException) {
            if (e.status == 404) { if (valid() && epoch == generation) { clear(); supported = false }; return }
            throw e
        }
        if (!valid() || epoch != generation) return
        supported = true
        enabled = page.optBoolean("enabled", true)
        if (!enabled) close()
        // A refresh replaces the first page but preserves explicitly loaded older rooms.
        val batch = page.optJSONArray("rooms")?.objects() ?: emptyList()
        rooms = if (page.optBoolean("has_more")) (batch + rooms.filter { old -> batch.none { it.optString("id") == old.optString("id") } }) else batch
        nextOffset = if (page.isNull("next_offset")) null else maxOf(nextOffset ?: 0, page.optInt("next_offset"))
        if (!history) { cache.rememberRooms(rooms); cacheUpdated() }
        selected?.let { id ->
            if ("agent_messaging.reveal_content" in caps) read(client, id, valid = valid)
        }
    }
    fun open(room: JSONObject) {
        // Saved events render at once (also offline); the read below replaces them.
        selection++; selected = room.getString("id"); current = room; events = cache.events(room.getString("id")); nextBefore = null; error = null
        val id = selected!!
        scope.launch { read(api(), id) }
    }
    private suspend fun read(client: Api, id: String, before: String? = null, valid: () -> Boolean = { true }) {
        val epoch = generation; val view = selection
        loading = true
        try {
            val body = JSONObject().put("room_id", id)
            before?.let { body.put("before", it) }
            val page = client.request("/rooms/read", "POST", body)
            if (epoch != generation || view != selection || id != selected || !valid()) return
            current = page.getJSONObject("room")
            events = mergeRoomEvents(events, page.getJSONArray("events").objects())
            cache.rememberEvents(id, events); cacheUpdated()
            events.lastOrNull { it.optString("kind", "chat") == "chat" && it.optString("content").isNotBlank() }?.let { previews = previews + (id to it) }
            if (before != null || nextBefore == null) nextBefore = page.optString("next_before").takeUnless { it.isBlank() || it == "null" }
            error = null
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            if (epoch == generation && view == selection && valid()) {
                if (e is ApiException && e.status in setOf(401, 403, 404, 410)) {
                    events = emptyList(); current = null; previews = previews - id
                    outbox.clearWhere { it == key(id) }
                    cache.forget(id); cacheUpdated()
                }
                error = e.message ?: "Cannot load conversation"
            }
        } finally { if (epoch == generation && view == selection) loading = false }
    }
    fun older() { val id = selected ?: return; val before = nextBefore ?: return; if (!loading) scope.launch { read(api(), id, before) } }
    fun retryRead() { val id = selected ?: return; if (!loading) scope.launch { read(api(), id) } }
    fun more() {
        val offset = nextOffset ?: return
        if (loading) return
        val epoch = generation
        scope.launch {
            loading = true
            try {
                val page = api().request(directoryPath(offset))
                if (epoch != generation) return@launch
                rooms = (rooms + page.getJSONArray("rooms").objects()).distinctBy { it.getString("id") }
                nextOffset = if (page.isNull("next_offset")) null else page.optInt("next_offset")
            } catch (e: Exception) { if (epoch == generation) error = e.message }
            finally { if (epoch == generation) loading = false }
        }
    }
    fun seen(through: String) {
        val id = selected ?: return; val epoch = generation
        scope.launch {
            try {
                api().request("/rooms/seen", "POST", JSONObject().put("room_id", id).put("through", through))
                if (epoch == generation) rooms = rooms.map { if (it.optString("id") == id) JSONObject(it.toString()).put("unread", 0) else it }
            } catch (_: Exception) { /* Reading can be retried after reconnect. */ }
        }
    }
    /**
     * Sends the composer, or retries the open room's oldest unconfirmed send. A new send is
     * persisted (frozen body, new `client_request_id`) before its request; the draft and reply
     * move into its local bubble at once.
     */
    fun send(attachments: List<String>, sent: (String, List<String>) -> Unit) {
        val id = selected ?: return
        if (!allowed() || busy || current?.optString("status") != "open") return
        val entry = pendingSend ?: run {
            val members = current?.optJSONArray("members")?.objects().orEmpty()
            val body = roomSendBody(id, UUID.randomUUID().toString(), draft, attachments, recipients.forMembers(members), replyTo)
            if (body.optString("content").isBlank() && body.getJSONArray("attachments").length() == 0) return
            OutboxEntry(body.getString("client_request_id"), key(id), "/rooms/send", body.toString(), java.time.Instant.now().toString()).also {
                outbox.enqueue(it)
                outbox.setDraft(key(id), "", null)
            }
        }
        deliver(entry, manual = true, sent)
    }
    /** Explicit retry from a bubble; also re-arms a definitively failed send. */
    fun retry(entryId: String, sent: (String, List<String>) -> Unit) {
        val entry = outbox.entry(entryId)?.takeIf { it.room } ?: return
        if (!allowed() || busy) return
        deliver(entry, manual = true, sent)
    }
    /** Drops a definitively failed send; its text returns to an empty composer. */
    fun discard(entryId: String) {
        val entry = outbox.entry(entryId)?.takeIf { it.room && it.failed && it.id !in sending } ?: return
        outbox.remove(entry.id)
        val body = runCatching { JSONObject(entry.body) }.getOrNull() ?: return
        if (outbox.draft(entry.conversation) == null) outbox.setDraft(entry.conversation, body.optString("content"),
            body.optString("reply_to").takeIf { it.isNotBlank() && body.has("reply_to") })
    }
    /**
     * Automatic retries: per room the oldest send that is due, in order, while rooms are
     * writable. Returns when the next backoff step is due (null when nothing waits).
     */
    fun pump(sent: (String, List<String>) -> Unit): Long? {
        if (!allowed()) return null
        val time = now()
        var next: Long? = null
        outbox.entries.filter { it.room && !it.failed }.groupBy { it.conversation }.values.forEach { queue ->
            val entry = queue.first()
            if (entry.id in sending) return@forEach
            if (entry.nextAttemptAt > time) { next = minOf(next ?: Long.MAX_VALUE, entry.nextAttemptAt); return@forEach }
            if (!busy) deliver(entry, manual = false, sent)
        }
        return next
    }
    private fun deliver(entry: OutboxEntry, manual: Boolean, sent: (String, List<String>) -> Unit) {
        if (entry.id in sending) return
        val roomId = entry.conversation.removePrefix(ConversationKey.ROOM_PREFIX)
        val epoch = generation
        sending = sending + entry.id
        if (manual) { busy = true; error = null }
        if (entry.failed) outbox.update(entry.id) { it.copy(failed = false, error = null) }
        scope.launch {
            try {
                beforeSend()
                when (val result = deliverOutboxEntry(api(), entry)) {
                    is OutboxResult.Accepted -> {
                        if (epoch != generation) return@launch
                        outbox.remove(entry.id)
                        val attachments = runCatching { JSONObject(entry.body).getJSONArray("attachments").strings().toList() }.getOrDefault(emptyList())
                        // The answer is the stored event: it replaces the local bubble without a gap.
                        acceptedRoomEvent(result.response, roomId)?.let { event -> if (selected == roomId) events = mergeRoomEvents(events, listOf(event)) }
                        sent(roomId, attachments)
                        if (selected == roomId) read(api(), roomId)
                    }
                    is OutboxResult.Rejected -> if (epoch == generation) {
                        outbox.update(entry.id) { it.afterFailure(result, now()) }
                        if (manual) error = result.error.message ?: "Send not confirmed. Retry uses the same message."
                    }
                }
            } finally {
                sending = sending - entry.id
                if (manual && epoch == generation) busy = false
            }
        }
    }
    fun loadCandidates() {
        val epoch = generation
        scope.launch { try {
            val result = api().request("/rooms/candidates")
            if (epoch == generation) candidates = result.getJSONArray("addresses").objects().filter { it.optString("engine") != "server" }
        } catch (e: Exception) { if (epoch == generation) error = e.message } }
    }
    fun operate(path: String, body: JSONObject, done: (JSONObject) -> Unit) {
        if (!allowed() || busy) return
        if (operation != null && (operation!!.optString("_path") != path || operation!!.optString("room_id") != body.optString("room_id") || operation!!.optString("action") != body.optString("action") || operation!!.optString("address_id") != body.optString("address_id"))) {
            error = "Retry the unconfirmed operation before starting another one."
            return
        }
        val epoch = generation
        // A lost response freezes the exact operation until its retry is confirmed.
        val request = operation ?: JSONObject(body.toString()).put("client_request_id", UUID.randomUUID().toString()).put("_path", path).also { operation = it }
        scope.launch {
            busy = true; error = null
            try {
                val result = api().request(request.getString("_path"), "POST", JSONObject(request.toString()).apply { remove("_path") })
                if (epoch == generation) { operation = null; done(result) }
            } catch (e: Exception) { if (epoch == generation) {
                if (e is ApiException && e.status in setOf(400, 403, 404, 413)) operation = null
                error = e.message
            } }
            finally { if (epoch == generation) busy = false }
        }
    }
}
