package io.uggs.orchestrator

import android.app.Application
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
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
fun JSONArray.strings() = (0 until length()).map { getString(it) }.toSet()

class CompanionModel(app: Application) : AndroidViewModel(app) {
    private val store = ConnectionStore(app)
    var connection by mutableStateOf(store.load()); private set
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
    private var polling: Job? = null
    private var stream: EventSource? = null
    private var reconnect: Job? = null
    private var pendingSend: Triple<String, String, String>? = null
    private var pendingOpen: String? = null
    private fun api() = connection!!.let { Api(it.server, it.token) }
    fun can(cap: String) = capabilities.contains(cap)
    fun fresh(now: Long = SystemClock.elapsedRealtime()) = online && lastSync > 0 && now - lastSync in 0..30_000
    fun reachable() = if (fresh() && can("agent_portal.manage") && can("agent_portal.reveal_transcript")) readyAgents(agents) else emptyList()
    private fun failure(e: Exception) {
        if (e is CancellationException) throw e
        error = if (e is ApiException) e.message ?: "Request failed" else "Connection lost. Try again."
        if (e !is ApiException) { online = false; status = "Offline" }
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
                store.save(c); connection = c; configurePush(getApplication(), c); beginPolling()
            } catch (e: Exception) { failure(e) } finally { busy = false }
        }
    }
    fun setForeground(value: Boolean) {
        foreground = value
        if (value) { online = false; connection?.let { configurePush(getApplication(), it) }; beginPolling(); if (selected != null) startStream() }
        else { polling?.cancel(); reconnect?.cancel(); stream?.cancel(); stream = null; VisibleConversation.session = null }
    }
    private fun beginPolling() {
        polling?.cancel()
        if (!foreground || connection == null) return
        polling = viewModelScope.launch {
            while (connection != null) {
                try { refresh() } catch (e: Exception) { failure(e) }
                delay(10_000)
            }
        }
    }
    private suspend fun refresh() {
        val client = api()
        val me = client.request("/me")
        capabilities = me.optJSONArray("capabilities")?.strings() ?: emptySet()
        follows = me.optJSONArray("follows")?.strings() ?: emptySet()
        notifications = me.optBoolean("notifications", true)
        val c = connection ?: return
        if (me.optJSONObject("firebase")?.toString() != c.firebase?.toString()) {
            connection = c.copy(firebase = me.optJSONObject("firebase")); store.save(connection!!); configurePush(getApplication(), connection!!)
        }
        if (can("hosts.activate_insecure")) {
            val result = client.request("/approvals")
            approvals = result.getJSONArray("requests").objects().filter { it.optBoolean("live") }
            defaultMinutes = result.optInt("default_duration_minutes", 480)
        } else approvals = emptyList()
        if (can("agent_portal.read")) {
            try { agents = client.request("/agents").getJSONArray("agents").objects() }
            catch (e: ApiException) { if (e.status == 503) { agents = emptyList(); status = "Agent portal is disabled" } else throw e }
        } else agents = emptyList()
        client.request("/device", "PATCH", JSONObject().put("visible_session_id", if (foreground) selected ?: JSONObject.NULL else JSONObject.NULL))
        VisibleConversation.session = if (foreground) selected else null
        if (selected != null && stream == null) startStream()
        if (!online) error = null
        status = "Live"; online = true; lastSync = SystemClock.elapsedRealtime()
        pendingOpen?.let { pendingOpen = null; openSession(it) }
    }
    fun refreshNow() { viewModelScope.launch { try { refresh() } catch (e: Exception) { failure(e) } } }
    fun openSession(id: String) {
        if (reachable().none { it.optString("id") == id }) { notice = "Agent is no longer reachable"; return }
        selected = id; events = emptyList(); draft = ""; pendingSend = null
        viewModelScope.launch {
            try {
                val page = api().request("/agents/$id/events?tail=1")
                if (selected != id) return@launch
                events = page.getJSONArray("events").objects()
                VisibleConversation.session = id
                api().request("/device", "PATCH", JSONObject().put("visible_session_id", id))
                startStream()
            } catch (e: Exception) { failure(e) }
        }
    }
    fun closeSession() { selected = null; events = emptyList(); stream?.cancel(); stream = null; reconnect?.cancel(); VisibleConversation.session = null; refreshNow() }
    private fun startStream() {
        reconnect?.cancel(); stream?.cancel()
        val id = selected ?: return
        if (!foreground || connection == null || !can("agent_portal.reveal_transcript")) return
        stream = api().stream(id, events.maxOfOrNull { it.optLong("cursor") } ?: 0, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, eventId: String?, type: String?, data: String) {
                if (type != "agent") return
                viewModelScope.launch {
                    if (selected != id) return@launch
                    runCatching { JSONObject(data) }.getOrNull()?.let { event ->
                        events = (events + event).distinctBy { it.optLong("cursor") }.sortedBy { it.optLong("cursor") }
                    }
                }
            }
            override fun onClosed(eventSource: EventSource) { scheduleReconnect(id) }
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                viewModelScope.launch {
                    if (response?.code == 401) failure(ApiException(401, "Device revoked"))
                    else scheduleReconnect(id)
                }
            }
        })
    }
    private fun scheduleReconnect(id: String) {
        if (!foreground || selected != id || connection == null) return
        reconnect?.cancel()
        reconnect = viewModelScope.launch { delay(3000); if (selected == id) startStream() }
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
            api().request(target, "POST", body); draft = ""; pendingSend = null; follows = follows + id; notice = "Sent"
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
    fun updateNotifications(value: Boolean) { mutate { api().request("/device", "PATCH", JSONObject().put("notifications", value)); notifications = value } }
    fun logout() { mutate { api().request("/device", "DELETE"); clearConnection() } }
    private fun clearConnection() {
        store.clear(); connection = null; selected = null; events = emptyList(); agents = emptyList(); approvals = emptyList(); capabilities = emptySet()
        online = false; lastSync = 0; pendingOpen = null; highlightApproval = null
        polling?.cancel(); reconnect?.cancel(); stream?.cancel(); stream = null; VisibleConversation.session = null
        android.app.NotificationManager::class.java.let { getApplication<Application>().getSystemService(it).cancelAll() }
        runCatching { com.google.firebase.messaging.FirebaseMessaging.getInstance().isAutoInitEnabled = false }
    }
    private fun mutate(block: suspend () -> Unit) {
        if (busy) return
        viewModelScope.launch {
            busy = true; error = null
            try { block(); if (connection != null) refresh() } catch (e: Exception) { failure(e); if (connection != null) runCatching { refresh() } }
            finally { busy = false }
        }
    }
    fun clearApprovalHighlight() { highlightApproval = null }
    fun notification(kind: String?, target: String?) {
        if (connection == null || target == null) return
        online = false
        if (kind == "approval") { closeSession(); highlightApproval = target }
        else if (runCatching { UUID.fromString(target) }.isSuccess) { closeSession(); pendingOpen = target; refreshNow() }
    }
    override fun onCleared() { stream?.cancel(); super.onCleared() }
}
