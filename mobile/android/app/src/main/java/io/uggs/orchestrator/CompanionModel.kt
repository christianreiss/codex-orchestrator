package io.uggs.orchestrator

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
fun JSONArray.strings() = (0 until length()).map { getString(it) }.toSet()

class CompanionModel(app: Application) : AndroidViewModel(app) {
    private val store = ConnectionStore(app)
    private val unreadStore = UnreadStore(app)
    var connection by mutableStateOf(store.load()); private set
    var unreadSessions by mutableStateOf<Set<String>>(emptySet()); private set
    val unreadCount get() = unreadSessions.size
    var agents by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var approvals by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var events by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var follows by mutableStateOf<Set<String>>(emptySet()); private set
    var capabilities by mutableStateOf<Set<String>>(emptySet()); private set
    var notifications by mutableStateOf(true); private set
    var selected by mutableStateOf<String?>(null); private set
    var lastSync by mutableStateOf(0L); private set
    var online by mutableStateOf(false); private set
    var notice by mutableStateOf<String?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    var status by mutableStateOf("Connecting…"); private set
    var busy by mutableStateOf(false); private set
    var draft by mutableStateOf("")
    var defaultMinutes by mutableStateOf(480); private set
    var highlightApproval by mutableStateOf<String?>(null); private set
    private var foreground = false
    private var socket: WebSocket? = null
    private var socketReady = false
    private var generation = 0
    private var revision = 0L
    private var lastFrame = 0L
    private var reconnectAttempt = 0
    private var maintenance: Job? = null
    private var refreshJob: Job? = null
    private val pendingScopes = mutableSetOf<String>()
    private var eventsLoaded = false
    private val presenceMutex = Mutex()
    private var reconnect: Job? = null
    private var pendingSend: Triple<String, String, String>? = null
    private var pendingOpen: String? = null
    private var permissionsKnown = false
    private var portalAvailable = true
    private val unreadPreferences = app.getSharedPreferences(UnreadStore.PREFERENCES, Context.MODE_PRIVATE)
    private val unreadListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        // Preference writes may run while the push service holds its own lock.
        // Defer notification reconciliation until the storage lock is released.
        viewModelScope.launch { yield(); refreshUnreadState() }
    }
    init {
        connection?.let(unreadStore::activate) ?: unreadStore.clear()
        unreadPreferences.registerOnSharedPreferenceChangeListener(unreadListener)
    }
    private fun api() = connection!!.let { Api(it.server, it.token) }
    fun can(cap: String) = capabilities.contains(cap)
    fun fresh(now: Long = SystemClock.elapsedRealtime()) = online && lastSync > 0 && now - lastSync in 0..30_000
    fun reachable() = if (fresh() && can("agent_portal.manage") && can("agent_portal.reveal_transcript")) readyAgents(agents) else emptyList()
    fun canReadSession(id: String) = connection != null && portalAvailable &&
        can("agent_portal.read") && can("agent_portal.reveal_transcript") && agents.any { it.optString("id") == id }
    fun overviewAgents(): List<JSONObject> = if (!can("agent_portal.read") || !can("agent_portal.reveal_transcript") || !portalAvailable) emptyList() else
        agents.filter { (fresh() && can("agent_portal.manage") && isReachable(it)) || it.optString("id") in unreadSessions }
            .sortedWith(compareByDescending<JSONObject> { can("agent_portal.manage") && needsReply(it) && isReachable(it) }
                .thenByDescending { it.optString("id") in unreadSessions }
                .thenByDescending { it.optLong("reply_cursor") })
    private fun refreshUnreadState() {
        unreadSessions = if (!permissionsKnown || !can("agent_portal.read") || !can("agent_portal.reveal_transcript") || !portalAvailable) emptySet() else unreadStore.unreadIds()
        if (permissionsKnown) {
            val allowed = notifications && portalAvailable && can("agent_portal.read") && can("agent_portal.reveal_transcript")
            syncUnreadNotifications(getApplication(), if (allowed) connection else null, if (allowed) unreadSessions else emptySet())
        }
    }
    fun markConversationRead(id: String, replyCursor: Long) {
        if (!foreground || !fresh() || selected != id || !canReadSession(id) || replyCursor <= 0) return
        if (events.none { it.optString("type") == "assistant_message" && it.optLong("cursor") == replyCursor &&
                !it.optJSONObject("payload")?.optString("text").isNullOrBlank() }) return
        unreadStore.markRead(id, replyCursor)
        refreshUnreadState()
    }
    private fun failure(e: Exception) {
        if (e is CancellationException) throw e
        error = if (e is ApiException) e.message ?: "Request failed" else "Connection lost. Try again."
        online = false; status = "Offline"
        if (e is ApiException && e.status == 401) { clearConnection(); error = "Device access expired or was revoked. Pair again." }
    }
    fun clearError() { error = null }
    fun clearNotice() { notice = null }
    fun pair(pairing: Pairing) {
        if (busy) return
        viewModelScope.launch {
            busy = true; error = null
            try {
                val result = Api(pairing.server).request("/pair", "POST", JSONObject().put("token", pairing.token).put("name", android.os.Build.MODEL))
                val c = Connection(pairing.server, result.getString("token"), result.getString("device_id"), result.optJSONObject("firebase"))
                store.save(c); connection = c; unreadStore.activate(c); unreadSessions = emptySet(); permissionsKnown = false
                configurePush(getApplication(), c); startLive()
            } catch (e: Exception) { failure(e) } finally { busy = false }
        }
    }
    fun setForeground(value: Boolean) {
        if (foreground == value) return
        foreground = value
        if (value) { connection?.let { configurePush(getApplication(), it) }; startLive() }
        else {
            stopLive()
            viewModelScope.launch { runCatching { updatePresence() } }
        }
    }
    private fun stopLive() {
        generation++; revision++; socketReady = false; online = false
        socket?.cancel(); socket = null
        maintenance?.cancel(); refreshJob?.cancel(); refreshJob = null; reconnect?.cancel()
        pendingScopes.clear(); VisibleConversation.session = null
    }
    private fun startLive() {
        stopLive()
        if (!foreground || connection == null) return
        status = "Connecting…"
        val current = generation
        lastFrame = SystemClock.elapsedRealtime()
        socket = api().live(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                viewModelScope.launch {
                    if (generation != current || !foreground) return@launch
                    val frame = runCatching { JSONObject(text) }.getOrNull() ?: return@launch
                    when (frame.optString("type")) {
                        "hello" -> { socketReady = true; invalidate() }
                        "changed" -> invalidate(frame.optJSONArray("scopes")?.strings() ?: emptySet())
                        "ping" -> if (online && pendingScopes.isEmpty() && refreshJob?.isActive != true) lastSync = SystemClock.elapsedRealtime()
                        else -> return@launch
                    }
                    lastFrame = SystemClock.elapsedRealtime()
                }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                viewModelScope.launch { if (generation == current) { if (code == 4001) failure(ApiException(401, "Device revoked")) else scheduleReconnect() } }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                viewModelScope.launch { if (generation == current) { if (response?.code == 401) failure(ApiException(401, "Device revoked")) else scheduleReconnect() } }
            }
        })
        maintenance = viewModelScope.launch {
            var presenceAt = 0L
            while (foreground && generation == current) {
                delay(5000)
                val now = SystemClock.elapsedRealtime()
                if (now - lastFrame >= 30_000) { scheduleReconnect(); break }
                if (socketReady && selected != null && now - presenceAt >= 20_000) {
                    presenceAt = now
                    try { updatePresence() } catch (e: Exception) { failure(e); scheduleReconnect() }
                }
            }
        }
    }
    private fun scheduleReconnect() {
        stopLive()
        if (!foreground || connection == null) return
        status = "Reconnecting…"
        val wait = (1000L shl reconnectAttempt.coerceAtMost(5)).coerceAtMost(30_000L)
        reconnectAttempt++
        reconnect = viewModelScope.launch { delay(wait); startLive() }
    }
    private fun invalidate(scopes: Set<String> = setOf("me", "agents", "approvals")) {
        if (!foreground || connection == null || !socketReady) return
        val known = scopes.intersect(setOf("me", "agents", "approvals"))
        if (known.isEmpty()) return
        revision++; pendingScopes.addAll(known)
        if (refreshJob?.isActive == true) return
        refreshJob = viewModelScope.launch {
            while (pendingScopes.isNotEmpty() && foreground && connection != null) {
                delay(60)
                val requested = pendingScopes.toSet(); pendingScopes.clear()
                val epoch = revision
                try { if (!refresh(requested, generation, epoch)) pendingScopes.addAll(requested) }
                catch (e: Exception) { failure(e); if (connection != null) scheduleReconnect(); return@launch }
            }
        }
    }
    private suspend fun refresh(scopes: Set<String>, current: Int, epoch: Long): Boolean {
        val client = api()
        val unreadRevision = unreadStore.revision()
        val me = if ("me" in scopes) client.request("/me") else null
        val caps = me?.optJSONArray("capabilities")?.strings() ?: capabilities
        val loadApprovals = "approvals" in scopes || me != null
        val loadAgents = "agents" in scopes || me != null
        val requests = if (loadApprovals && "hosts.activate_insecure" in caps) client.request("/approvals") else null
        var portalDisabled = false
        val snapshot = if (loadAgents && "agent_portal.read" in caps) {
            try { client.request("/agents") }
            catch (e: ApiException) { if (e.status == 503 && e.code == "agent_portal_disabled") { portalDisabled = true; null } else throw e }
        } else null
        val id = selected
        var transcriptAllowed = "agent_portal.reveal_transcript" in caps && !portalDisabled
        val nextEvents = if (loadAgents && id != null && transcriptAllowed) {
            val expectedReply = snapshot?.optJSONArray("agents")?.objects()?.firstOrNull { it.optString("id") == id }?.optLong("reply_cursor") ?: 0
            try { loadEvents(client, id, expectedReply) }
            catch (e: ApiException) {
                if (e.status in setOf(403, 404, 410)) { transcriptAllowed = false; null } else throw e
            }
        } else null
        if (current != generation || epoch != revision || !foreground) return false
        capabilities = caps
        permissionsKnown = true
        if (loadAgents) portalAvailable = !portalDisabled
        if (me != null) {
            follows = me.optJSONArray("follows")?.strings() ?: emptySet()
            notifications = me.optBoolean("notifications", true)
            val c = connection ?: return false
            if (me.optJSONObject("firebase")?.toString() != c.firebase?.toString()) {
                connection = c.copy(firebase = me.optJSONObject("firebase")); store.save(connection!!); configurePush(getApplication(), connection!!)
            }
        }
        if (loadApprovals) {
            approvals = requests?.getJSONArray("requests")?.objects()?.filter { it.optBoolean("live") } ?: emptyList()
            defaultMinutes = requests?.optInt("default_duration_minutes", 480) ?: 480
        }
        if (loadAgents) agents = snapshot?.getJSONArray("agents")?.objects() ?: emptyList()
        if (loadAgents && snapshot != null && "agent_portal.reveal_transcript" in caps && !portalDisabled) {
            if (!unreadStore.observeReplies(agents, unreadRevision)) pendingScopes.add("agents")
        }
        if (!transcriptAllowed) { selected = null; events = emptyList(); eventsLoaded = false; VisibleConversation.session = null }
        else if (nextEvents != null && selected == id) { events = nextEvents; eventsLoaded = true }
        val reconnected = !online
        if (reconnected) error = null
        status = if (!portalAvailable) "Agent portal is disabled" else "Live"
        online = socketReady; lastSync = SystemClock.elapsedRealtime(); reconnectAttempt = 0
        refreshUnreadState()
        if (reconnected && selected != null) viewModelScope.launch { runCatching { updatePresence() } }
        pendingOpen?.let { pendingOpen = null; openSession(it) }
        return true
    }
    private suspend fun loadEvents(client: Api, id: String, expectedReply: Long): List<JSONObject> {
        var result = events
        var cursor = result.maxOfOrNull { it.optLong("cursor") } ?: 0
        var tail = !eventsLoaded
        do {
            val page = client.request("/agents/$id/events?${if (tail) "tail=1" else "after=$cursor"}")
            val batch = page.getJSONArray("events").objects()
            result = (result + batch).distinctBy { it.optLong("cursor") }.sortedBy { it.optLong("cursor") }
            val next = page.optLong("next_cursor", cursor)
            if (next <= cursor || batch.size < 250) break
            cursor = next; tail = false
        } while (true)
        // Progress can fill the tail without any visible chat message. Load
        // the exact last reply advertised by the authorized overview in that
        // case, rather than acknowledging a cursor whose text was never seen.
        if (expectedReply > 0 && result.none { it.optString("type") == "assistant_message" && it.optLong("cursor") >= expectedReply }) {
            val replyPage = client.request("/agents/$id/events?after=${expectedReply - 1}")
            result = (result + replyPage.getJSONArray("events").objects()).distinctBy { it.optLong("cursor") }.sortedBy { it.optLong("cursor") }
        }
        return result
    }
    private suspend fun updatePresence() = presenceMutex.withLock {
        val c = connection ?: return@withLock
        val id = if (foreground && can("agent_portal.reveal_transcript")) selected else null
        VisibleConversation.session = id
        Api(c.server, c.token).request("/device", "PATCH", JSONObject().put("visible_session_id", id ?: JSONObject.NULL))
    }
    fun refreshNow() { if (socketReady) invalidate() else startLive() }
    fun openSession(id: String) {
        if (!canReadSession(id)) { notice = "Conversation is no longer available"; return }
        selected = id; events = emptyList(); eventsLoaded = false; draft = ""; pendingSend = null
        invalidate(setOf("agents"))
        viewModelScope.launch {
            try { updatePresence() } catch (e: Exception) { failure(e) }
        }
    }
    fun closeSession() {
        selected = null; events = emptyList(); eventsLoaded = false; VisibleConversation.session = null
        invalidate(setOf("agents"))
        if (foreground && connection != null) viewModelScope.launch { runCatching { updatePresence() } }
    }
    fun follow(id: String, value: Boolean) { mutate { api().request("/agents/$id/follow", "PUT", JSONObject().put("followed", value)); follows = if (value) follows + id else follows - id } }
    fun send(prompt: JSONObject? = null) {
        val id = selected ?: return
        if (reachable().none { it.optString("id") == id }) { error = "Agent is no longer reachable"; return }
        val text = draft.trim(); if (text.isEmpty()) return
        val target = if (prompt != null) "/agents/$id/prompts/${prompt.getString("id")}/answer" else "/agents/$id/messages"
        val prior = pendingSend
        val uuid = if (prior?.first == target && prior.second == text) prior.third else UUID.randomUUID().toString()
        pendingSend = Triple(target, text, uuid)
        mutate {
            val body = JSONObject().put("client_message_id", uuid).put(if (prompt == null) "content" else "answer", text)
            if (prompt != null) body.put("version", prompt.optInt("version", 1))
            api().request(target, "POST", body)
            if (selected == id) { draft = ""; pendingSend = null }
            follows = follows + id; notice = "Sent"
        }
    }
    fun decide(id: Long, approve: Boolean, minutes: Int, onSuccess: () -> Unit = {}) {
        if (!fresh() || approvals.none { it.optLong("id") == id && liveApproval(it, System.currentTimeMillis()) }) {
            error = "Request is no longer available"; refreshNow(); return
        }
        mutate {
            // The server locks and rechecks pending state and expiry at decision time.
            api().request("/approvals/$id/${if (approve) "approve" else "deny"}", "POST", JSONObject().put("duration_minutes", minutes))
            approvals = approvals.filterNot { it.optLong("id") == id }
            notice = if (approve) "Access allowed for ${durationLabel(minutes)}" else "Access denied"
            onSuccess()
        }
    }
    fun updateNotifications(value: Boolean) { mutate {
        api().request("/device", "PATCH", JSONObject().put("notifications", value))
        notifications = value; refreshUnreadState()
    } }
    fun logout() { mutate { api().request("/device", "DELETE"); clearConnection() } }
    private fun clearConnection() {
        store.clear(); connection = null; selected = null; events = emptyList(); agents = emptyList(); approvals = emptyList(); capabilities = emptySet()
        unreadStore.clear(); unreadSessions = emptySet(); permissionsKnown = false
        syncUnreadNotifications(getApplication(), null, emptySet())
        online = false; lastSync = 0; pendingOpen = null; highlightApproval = null
        stopLive()
        android.app.NotificationManager::class.java.let { getApplication<Application>().getSystemService(it).cancelAll() }
        runCatching { com.google.firebase.messaging.FirebaseMessaging.getInstance().isAutoInitEnabled = false }
    }
    private fun mutate(block: suspend () -> Unit) {
        if (busy) return
        viewModelScope.launch {
            busy = true; error = null
            revision++
            try { block(); if (connection != null) refreshNow() } catch (e: Exception) { failure(e); if (connection != null) refreshNow() }
            finally { busy = false }
        }
    }
    fun clearApprovalHighlight() { highlightApproval = null }
    fun notification(kind: String?, target: String?) {
        if (connection == null) return
        if (kind == "unread") { closeSession(); refreshNow(); return }
        if (target == null) return
        online = false
        if (kind == "approval") { closeSession(); highlightApproval = target }
        else if (runCatching { UUID.fromString(target) }.isSuccess) { closeSession(); pendingOpen = target; refreshNow() }
    }
    override fun onCleared() { unreadPreferences.unregisterOnSharedPreferenceChangeListener(unreadListener); stopLive(); super.onCleared() }
}
