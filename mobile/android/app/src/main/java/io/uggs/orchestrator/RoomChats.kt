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
internal fun mergeRoomEvents(old: List<JSONObject>, fresh: List<JSONObject>): List<JSONObject> =
    (old + fresh).associateBy { it.getString("id") }.values.sortedWith(compareBy({ it.optString("created_at") }, { it.optString("id") }))

/** Shared room state stays separate from private Portal cursors and device follows. */
internal class RoomChats(
    private val scope: CoroutineScope,
    private val api: () -> Api,
    private val allowed: () -> Boolean,
) {
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
    private var drafts by mutableStateOf<Map<String, String>>(emptyMap())
    private var targets by mutableStateOf<Map<String, String>>(emptyMap())
    private var pending by mutableStateOf<Map<String, JSONObject>>(emptyMap())
    var draft: String
        get() = drafts[selected].orEmpty()
        set(value) { selected?.let { drafts = drafts + (it to value) } }
    var target: String
        get() = targets[selected].orEmpty()
        set(value) { selected?.let { targets = targets + (it to value) } }
    val pendingSend get() = pending[selected]
    private var generation = 0
    private var selection = 0
    private var operation by mutableStateOf<JSONObject?>(null)
    val pendingOperation get() = operation
    fun clear() {
        generation++; selection++; rooms = emptyList(); selected = null; current = null
        events = emptyList(); drafts = emptyMap(); targets = emptyMap(); pending = emptyMap()
        candidates = emptyList(); nextBefore = null; nextOffset = null; error = null
        loading = false; busy = false; operation = null; supported = true; enabled = true; history = false
    }
    fun close() { selection++; selected = null; current = null; events = emptyList(); nextBefore = null; error = null; loading = false }
    suspend fun refresh(client: Api, caps: Set<String>, valid: () -> Boolean) {
        if ("agent_messaging.read" !in caps) { if (valid()) clear(); return }
        if ("agent_messaging.reveal_content" !in caps && valid()) {
            close(); drafts = emptyMap(); pending = emptyMap()
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
        selected?.let { id ->
            if ("agent_messaging.reveal_content" in caps) read(client, id, valid = valid)
        }
    }
    fun open(room: JSONObject) {
        selection++; selected = room.getString("id"); current = room; events = emptyList(); nextBefore = null; error = null
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
            if (before != null || nextBefore == null) nextBefore = page.optString("next_before").takeUnless { it.isBlank() || it == "null" }
            error = null
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            if (epoch == generation && view == selection && valid()) {
                if (e is ApiException && e.status in setOf(401, 403, 404, 410)) { events = emptyList(); current = null; drafts = drafts - id; pending = pending - id }
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
    fun send(attachments: List<String>, sent: (String, List<String>) -> Unit) {
        val id = selected ?: return
        if (!allowed() || busy || current?.optString("status") != "open") return
        val body = pending[id] ?: JSONObject().put("room_id", id).put("client_request_id", UUID.randomUUID().toString())
            .put("content", draft).put("attachments", JSONArray(attachments)).apply {
                if (target == "all") put("ask_all", true) else if (target.isNotBlank()) put("recipients", JSONArray(listOf(target)))
            }
        if (body.optString("content").isBlank() && body.getJSONArray("attachments").length() == 0) return
        pending = pending + (id to body)
        val epoch = generation
        scope.launch {
            busy = true; error = null
            try {
                api().request("/rooms/send", "POST", body)
                if (epoch != generation) return@launch
                pending = pending - id
                if (drafts[id] == body.optString("content")) drafts = drafts + (id to "")
                sent(id, body.getJSONArray("attachments").strings().toList())
                if (selected == id) read(api(), id)
            } catch (e: Exception) { if (epoch == generation) {
                if (e is ApiException && e.status in setOf(400, 403, 404, 413)) pending = pending - id
                error = e.message ?: "Send not confirmed. Retry uses the same message."
            } }
            finally { if (epoch == generation) busy = false }
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
