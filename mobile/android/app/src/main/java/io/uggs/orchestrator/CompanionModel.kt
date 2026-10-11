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
    private var unreadReplyCounts by mutableStateOf<Map<String, Int>>(emptyMap())
    val unreadCount get() = unreadSessions.size
    fun unreadReplyCount(id: String) = unreadReplyCounts[id] ?: 0
    var agents by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var hosts by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var pendingStart by mutableStateOf(connection?.let { store.loadPendingStart(it.deviceId) }); private set
    var approvals by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var events by mutableStateOf<List<JSONObject>>(emptyList()); private set
    private var pendingChats by mutableStateOf<Map<String, List<PendingChat>>>(emptyMap())
    val chatEvents: List<JSONObject> get() = events + (pendingChats[selected] ?: emptyList()).map { it.event() }
    private var localChatCursor = 0L
    var follows by mutableStateOf<Set<String>>(emptySet()); private set
    var capabilities by mutableStateOf<Set<String>>(emptySet()); private set
    var notifications by mutableStateOf(true); private set
    var selected by mutableStateOf<String?>(null); private set
    var lastSync by mutableStateOf(0L); private set
    var online by mutableStateOf(false); private set
    var notice by mutableStateOf<String?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    var status by mutableStateOf("Connecting…"); private set
    val connecting get() = connection != null && !online && status == "Connecting…" && error == null
    var busy by mutableStateOf(false); private set
    private var chatDrafts by mutableStateOf<Map<String,String>>(emptyMap())
    var draft: String
        get() = chatDrafts[selected] ?: ""
        set(value) { selected?.let { chatDrafts = chatDrafts + (it to value) } }
    var chatUploads by mutableStateOf<Map<String,List<ChatUpload>>>(emptyMap()); private set
    var replyTargets by mutableStateOf<Map<String,Long>>(emptyMap()); private set
    private val uploadJobs = mutableMapOf<String,Job>()
    private data class ChatSend(val session:String,val target:String,val text:String,val metadata:String,val uuid:String,val version:Int?)
    private val chatSends = mutableMapOf<String,ChatSend>()
    private val noticeOperations = mutableMapOf<String,String>()
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
    private var activityServerAt = 0L
    private var activitySnapshotAt = 0L
    fun activityNow(): Long = if (activityServerAt > 0) activityServerAt + (SystemClock.elapsedRealtime() - activitySnapshotAt).coerceAtLeast(0) else System.currentTimeMillis()
    private var reconnect: Job? = null
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
    fun reachable() = if (fresh() && can("agent_portal.manage") && can("agent_portal.reveal_transcript")) readyAgents(agents).filter { !it.optBoolean("daemon_session") || can("agent_messaging.manage") } else emptyList()
    fun canReadSession(id: String) = connection != null && portalAvailable &&
        can("agent_portal.read") && can("agent_portal.reveal_transcript") && agents.any { it.optString("id") == id }
    fun overviewAgents(): List<JSONObject> = if (!can("agent_portal.read") || !can("agent_portal.reveal_transcript") || !portalAvailable) emptyList() else
        retainedChats(agents)
    fun canSpawn() = fresh() && portalAvailable && can("agent_messaging.manage") && can("agent_portal.manage") && can("agent_portal.read") && can("agent_portal.reveal_transcript")
    fun canSendSession(id: String?) = id != null && reachable().any { it.optString("id") == id }
    private fun refreshUnreadState() {
        unreadSessions = if (!permissionsKnown || !can("agent_portal.read") || !can("agent_portal.reveal_transcript") || !portalAvailable) emptySet() else unreadStore.unreadIds()
        unreadReplyCounts = unreadSessions.associateWith(unreadStore::unreadReplyCount)
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
                store.save(c); connection = c; unreadStore.activate(c); unreadSessions = emptySet(); unreadReplyCounts = emptyMap(); permissionsKnown = false
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
        status = if (reconnectAttempt > 0 || error != null) "Reconnecting…" else "Connecting…"
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
    private fun invalidate(scopes: Set<String> = setOf("me", "agents", "approvals", "hosts")) {
        if (!foreground || connection == null || !socketReady) return
        val known = scopes.intersect(setOf("me", "agents", "approvals", "hosts"))
        if (known.isEmpty()) return
        // Metadata changes queue another read; they must not starve the read
        // already in flight. Permission changes still fence its result.
        if ("me" in known) revision++
        pendingScopes.addAll(known)
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
            try { client.request("/agents", "POST", JSONObject().put("read_cursors", unreadStore.readCursors())) }
            catch (e: ApiException) { if (e.status == 503 && e.code == "agent_portal_disabled") { portalDisabled = true; null } else throw e }
        } else null
        val hostSnapshot = if (("hosts" in scopes || me != null) && "admin.read" in caps) client.request("/hosts") else null
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
        if ("hosts" in scopes || me != null) hosts = hostSnapshot?.optJSONArray("hosts")?.objects() ?: emptyList()
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
        if (loadAgents) {
            agents = snapshot?.getJSONArray("agents")?.objects() ?: emptyList()
            activityServerAt = runCatching { java.time.Instant.parse(snapshot?.optString("generated_at")).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
            activitySnapshotAt = SystemClock.elapsedRealtime()
        }
        if (loadAgents && snapshot != null && "agent_portal.reveal_transcript" in caps && !portalDisabled) {
            if (!unreadStore.observeReplies(agents, unreadRevision)) pendingScopes.add("agents")
        }
        if (!transcriptAllowed) { selected = null; events = emptyList(); pendingChats = emptyMap(); chatSends.clear(); eventsLoaded = false; VisibleConversation.session = null }
        else if (nextEvents != null && selected == id) {
            events = nextEvents; eventsLoaded = true
            if (id != null) pendingChats = pendingChats + (id to pendingChatsAfterRefresh(pendingChats[id] ?: emptyList(), nextEvents))
        }
        val reconnected = !online
        if (reconnected) error = null
        status = if (!portalAvailable) "Agent portal is disabled" else "Live"
        online = socketReady; lastSync = SystemClock.elapsedRealtime(); reconnectAttempt = 0
        refreshUnreadState()
        if (reconnected && selected != null) viewModelScope.launch { runCatching { updatePresence() } }
        pendingOpen?.let { if (loadAgents) { pendingOpen = null; openSession(it) } }
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
        revision++
        selected = id; events = emptyList(); eventsLoaded = false
        invalidate(setOf("agents"))
        viewModelScope.launch {
            try { updatePresence() } catch (e: Exception) { failure(e) }
        }
    }
    fun closeSession() {
        revision++
        selected = null; events = emptyList(); eventsLoaded = false; VisibleConversation.session = null
        invalidate(setOf("agents"))
        if (foreground && connection != null) viewModelScope.launch { runCatching { updatePresence() } }
    }
    fun follow(id: String, value: Boolean) { mutate { api().request("/agents/$id/follow", "PUT", JSONObject().put("followed", value)); follows = if (value) follows + id else follows - id } }
    fun replyTo(cursor: Long?) { val id=selected ?: return; replyTargets = if(cursor == null) replyTargets - id else replyTargets + (id to cursor) }
    fun chatError(message:String) { error=message }
    fun addChatFile(session:String, uri:android.net.Uri) {
        viewModelScope.launch { try { val (file,name,mime) = copyChatFile(getApplication(),uri); addCapturedFile(session,file,name,mime) } catch(e:Exception) { chatError(e.message ?: "Cannot read file") } }
    }
    fun addCapturedFile(session:String,file:java.io.File,name:String,mime:String) {
        val current=chatUploads[session] ?: emptyList()
        if(current.size >= 10 || file.length() !in 1..CHAT_FILE_LIMIT || current.sumOf { it.file.length() } + file.length() > CHAT_TOTAL_LIMIT) { file.delete(); chatError("Attachment limit exceeded"); return }
        val item=ChatUpload(UUID.randomUUID().toString(),file,name,mime)
        chatUploads=chatUploads + (session to (current + item)); retryChatUpload(session,item)
    }
    fun retryChatUpload(session:String,item:ChatUpload) {
        if(uploadJobs[item.id]?.isActive == true) return
        val client=api()
        fun update(progress:Float,state:String,error:String?=null) { chatUploads=chatUploads + (session to (chatUploads[session] ?: emptyList()).map { if(it.id == item.id) it.copy(progress=progress,state=state,error=error) else it }) }
        uploadJobs[item.id]=viewModelScope.launch {
            update(item.progress,"uploading")
            try {
                val base="/agents/$session/attachments"
                val digest=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { val hash=java.security.MessageDigest.getInstance("SHA-256"); item.file.inputStream().use { input -> val buffer=ByteArray(65536); while(true) { val count=input.read(buffer); if(count<0) break; hash.update(buffer,0,count) } }; hash.digest().joinToString("") { "%02x".format(it) } }
                val created=client.request(base,"POST",JSONObject().put("id",item.id).put("name",item.name).put("mime_type",item.mime).put("size_bytes",item.file.length()).put("sha256",digest))
                var offset=created.optLong("uploaded_bytes")
                while(offset < item.file.length()) {
                    val bytes=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { java.io.RandomAccessFile(item.file,"r").use { input -> input.seek(offset); ByteArray(minOf(4*1024*1024L,item.file.length()-offset).toInt()).also { input.readFully(it) } } }
                    val next=client.request("$base/${item.id}/chunks","POST",JSONObject().put("offset",offset).put("content_b64",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP)))
                    offset=next.getLong("uploaded_bytes"); update(offset.toFloat()/item.file.length(),"uploading")
                }
                client.request("$base/${item.id}/seal","POST"); update(1f,"ready")
            } catch(e:CancellationException) { throw e }
            catch(e:Exception) { update(item.progress,"failed",e.message ?: "Upload failed") }
        }
    }
    fun removeChatUpload(session:String,id:String) {
        uploadJobs.remove(id)?.cancel()
        val item=chatUploads[session]?.find { it.id == id }
        chatUploads=chatUploads + (session to (chatUploads[session] ?: emptyList()).filter { it.id != id })
        viewModelScope.launch { runCatching { api().request("/agents/$session/attachments/$id","DELETE") }; item?.file?.delete() }
    }
    suspend fun chatAttachmentInfo(session:String,id:String) = api().request("/agents/$session/attachments/$id")
    suspend fun downloadChatAttachment(session:String,id:String):java.io.File {
        val dir=java.io.File(getApplication<Application>().cacheDir,"chat-downloads").apply { mkdirs() }
        val file=java.io.File(dir,"${connection!!.deviceId}-$id")
        if(file.exists()) return file
        val info=chatAttachmentInfo(session,id)
        api().download("/agents/$session/attachments/$id/content",file)
        val actual=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { val hash=java.security.MessageDigest.getInstance("SHA-256"); file.inputStream().use { input -> val buf=ByteArray(65536);while(true){val n=input.read(buf);if(n<0)break;hash.update(buf,0,n)} }; hash.digest().joinToString("") { "%02x".format(it) } }
        if(actual != info.optString("sha256")) { file.delete(); error("Attachment checksum mismatch") }
        return file
    }
    fun saveChatAttachment(file:java.io.File,uri:android.net.Uri) {
        mutate { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            getApplication<Application>().contentResolver.openOutputStream(uri)?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: error("Cannot save file")
        };notice="File saved" }
    }
    fun resolveChatNotice(session:String,id:String) {
        val operation=noticeOperations.getOrPut(id) { UUID.randomUUID().toString() }
        mutate { api().request("/agents/$session/notices/resolve","POST",JSONObject().put("notice_id",id).put("client_event_id",operation)); notice="Marked resolved" }
    }
    fun send(prompt: JSONObject? = null, choiceValue:String? = null) {
        if (busy) return
        val id = selected ?: return
        if (!canSendSession(id)) { error = "Agent is no longer reachable"; return }
        val text = draft.trim(); val items=chatUploads[id] ?: emptyList()
        if(text.isEmpty() && items.isEmpty()) return
        if(items.any { it.state != "ready" }) { error="Finish or remove pending uploads"; return }
        val metadata=JSONObject().put("attachments",JSONArray(items.map { it.id }))
        replyTargets[id]?.let { metadata.put("reply_to",it) }; choiceValue?.let { metadata.put("choice_value",it) }
        val previous=chatSends.values.lastOrNull { it.session == id && it.text == text && it.metadata == metadata.toString() }
        val intent=if(previous != null && (prompt == null || previous.target.contains("/${prompt.optString("id")}/")) && previous.text == text && previous.metadata == metadata.toString()) previous else ChatSend(
            id, if(prompt != null) "/agents/$id/prompts/${prompt.getString("id")}/answer" else "/agents/$id/messages", text,metadata.toString(),UUID.randomUUID().toString(),prompt?.optInt("version",1))
        submitChat(intent)
    }
    fun retryChat(clientId: String) {
        val intent = chatSends[clientId] ?: return
        if (busy || selected != intent.session || !canSendSession(intent.session)) return
        submitChat(intent)
    }
    private fun submitChat(intent: ChatSend) {
        val id = intent.session
        val items = chatUploads[id] ?: emptyList()
        val previous = pendingChats[id] ?: emptyList()
        val bubble = previous.firstOrNull { it.clientId == intent.uuid }?.copy(status = "sending")
            ?: PendingChat(intent.uuid, --localChatCursor, intent.text, intent.metadata, java.time.Instant.now().toString())
        pendingChats = pendingChats + (id to (previous.filterNot { it.clientId == intent.uuid } + bubble))
        chatSends[intent.uuid] = intent
        val owner = connection
        mutate {
            try {
                val body=JSONObject().put("client_message_id",intent.uuid).put(if(intent.version != null) "answer" else "content",intent.text).put("metadata",JSONObject(intent.metadata))
                intent.version?.let { body.put("version",it) }
                val result = api().request(intent.target,"POST",body)
                if (connection != owner) return@mutate
                val messageId = (result.opt("message_id") as? String) ?: (result.opt("operation_id") as? String)
                    ?: error("Delivery was not confirmed. Retry this message.")
                val failed = result.optString("status") in setOf("canceled", "dead")
                updatePendingChat(id, intent.uuid, if (failed) "failed" else "queued", messageId)
                chatSends.remove(intent.uuid)
                if (!failed) {
                    if(chatDrafts[id]?.trim() == intent.text) chatDrafts = chatDrafts + (id to "")
                    val sentIds = JSONObject(intent.metadata).optJSONArray("attachments")?.strings() ?: emptySet()
                    chatUploads = chatUploads + (id to (chatUploads[id] ?: emptyList()).filterNot { it.id in sentIds })
                    replyTargets=replyTargets - id
                    items.filter { it.id in sentIds }.forEach { it.file.delete() }; follows=follows + id
                }
            } catch (e: Exception) {
                if (connection == owner) updatePendingChat(id, intent.uuid, "unconfirmed")
                throw e
            }
        }
    }
    private fun updatePendingChat(session: String, clientId: String, status: String, messageId: String? = null) {
        val pending = (pendingChats[session] ?: emptyList()).map {
            if (it.clientId == clientId) it.copy(status = status, messageId = messageId ?: it.messageId) else it
        }
        pendingChats = pendingChats + (session to if (selected == session) pendingChatsAfterRefresh(pending, events) else pending)
    }
    fun startHost(hostId: Long, engine: String, task: String, title: String, cwd: String, onSuccess: () -> Unit) {
        if (pendingStart != null || busy || !canSpawn() || hosts.none { it.optLong("host_id") == hostId && it.optBoolean("startable") && engine in (it.optJSONArray("engines")?.strings() ?: emptySet()) }) return
        val body = JSONObject().put("host_id", hostId).put("engine", engine).put("task", task.trim()).put("title", title.trim()).put("client_message_id", UUID.randomUUID().toString())
        if (cwd.isNotBlank()) body.put("cwd", cwd.trim())
        store.savePendingStart(connection!!.deviceId, body); pendingStart = body
        retryStart(onSuccess)
    }
    fun retryStart(onSuccess: () -> Unit = {}) {
        val body = pendingStart ?: return
        val c = connection ?: return
        if (busy || !canSpawn()) return
        viewModelScope.launch {
            busy = true; error = null; revision++
            try {
                val result = Api(c.server, c.token).request("/daemon-sessions", "POST", body)
                if (connection?.deviceId != c.deviceId) return@launch
                store.clearPendingStart(); pendingStart = null
                pendingOpen = result.getString("session_id")
                notice = "Start queued — waiting for the agent"
                onSuccess(); refreshNow()
            } catch (e: Exception) {
                if (e is ApiException && e.status in setOf(400, 403, 404, 409)) { store.clearPendingStart(); pendingStart = null }
                failure(e); if (connection != null) refreshNow()
            } finally { busy = false }
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
        uploadJobs.values.forEach { it.cancel() }; uploadJobs.clear()
        chatUploads.values.flatten().forEach { it.file.delete() }; chatUploads=emptyMap(); chatDrafts=emptyMap(); replyTargets=emptyMap(); chatSends.clear(); noticeOperations.clear()
        java.io.File(getApplication<Application>().cacheDir,"chat-downloads").deleteRecursively()
        store.clear(); connection = null; selected = null; events = emptyList(); pendingChats = emptyMap(); agents = emptyList(); hosts = emptyList(); pendingStart = null; approvals = emptyList(); capabilities = emptySet()
        unreadStore.clear(); unreadSessions = emptySet(); unreadReplyCounts = emptyMap(); permissionsKnown = false
        syncUnreadNotifications(getApplication(), null, emptySet())
        online = false; lastSync = 0; reconnectAttempt = 0; pendingOpen = null; highlightApproval = null
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
