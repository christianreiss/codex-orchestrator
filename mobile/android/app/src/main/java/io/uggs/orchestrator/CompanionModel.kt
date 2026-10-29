package io.uggs.orchestrator

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.WebSocket
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Facade over the companion's state. Cohesive slices live beside it:
 * [RoomChats] (rooms), [ChatUploads] (attachments), [UnreadState] (unread +
 * notifications), [QuotaState], [AccessRequests] (approvals/windows),
 * [ChatCacheWriter] (encrypted cache), [ChatOutbox] (persisted sends and
 * drafts), [RoomHistoryCache] (offline rooms), `CompanionLive.kt` (socket frames),
 * `DirectHistory.kt` / `DirectChatSend.kt` (direct transcript and sends).
 * Live refresh and its generation/revision fencing stay here as one block.
 */
class CompanionModel(app: Application) : AndroidViewModel(app) {
    private val texts: Texts = ContextTexts(app)
    private val store = ConnectionStore(app)
    private val unreadStore = UnreadStore(app)
    var connection by mutableStateOf(store.load()); private set
    /** Unconfirmed sends and drafts of direct chats and rooms, one encrypted blob. */
    private val outboxHub = OutboxHub.get(app)
    private val outbox = outboxHub.outbox
    private val outboxWriter = outboxHub.writer
    private val outboxReady = outboxHub.bind(connection?.let(ChatHistoryCache::owner).orEmpty())
    private val roomWriter = ChatCacheWriter(ChatCacheStore(app, RoomHistoryCache.FILE, RoomHistoryCache.MAX_BYTES))
    internal val roomChats = RoomChats(viewModelScope, { api() }, { fresh() && can("agent_messaging.manage") && can("agent_messaging.reveal_content") },
        outbox, { cache -> roomWriter.persistBody(cache.takeUnless { it.isEmpty }?.json()) }, { outboxWriter.flush() },
        owner = connection?.let(ChatHistoryCache::owner).orEmpty(), texts = texts)
    private val cacheWriter = ChatCacheWriter(ChatCacheStore(app))
    private var historyCache = ChatHistoryCache(connection?.let(ChatHistoryCache::owner).orEmpty())
    private var cachedOverview by mutableStateOf(false)
    val showingSavedChats get() = cachedOverview && !permissionsKnown
    var showingCachedTranscript by mutableStateOf(false); private set
    private val unread = UnreadState(app, unreadStore)
    val unreadSessions: Set<String> get() = unread.sessions
    val unreadCount get() = unreadSessions.size
    fun unreadReplyCount(id: String) = unread.replyCount(id)
    var agents by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var hosts by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var pendingStart by mutableStateOf(connection?.let { store.loadPendingStart(it.deviceId) }); private set
    private val access = AccessRequests()
    val approvals: List<JSONObject> get() = access.approvals
    val activeWindows: List<JSONObject> get() = access.activeWindows
    val fleetWindow: JSONObject? get() = access.fleetWindow
    var events by mutableStateOf<List<JSONObject>>(emptyList()); private set
    private var pendingChats by mutableStateOf<Map<String, List<PendingChat>>>(emptyMap())
    val chatEvents: List<JSONObject> get() = events + (pendingChats[selected] ?: emptyList()).map { it.event() }
    private var localChatCursor = 0L
    var follows by mutableStateOf<Set<String>>(emptySet()); private set
    var capabilities by mutableStateOf<Set<String>>(emptySet()); private set
    var notifications by mutableStateOf(true); private set
    var selected by mutableStateOf<String?>(null); private set
    var lastSync by mutableStateOf(0L); private set
    private val quotas = QuotaState({ api() }, { foreground && connection != null }, { can("admin.read") && can("auth.read_metadata") }, { connection to generation }, texts)
    val quotaEngines: List<JSONObject> get() = quotas.engines
    val quotaError: String? get() = quotas.error
    val quotaLoading: Boolean get() = quotas.loading
    suspend fun refreshQuotas() = quotas.refresh()
    var online by mutableStateOf(false); private set
    var notice by mutableStateOf<String?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    private enum class LiveStatus { Connecting, Reconnecting, Offline, Live, PortalDisabled }
    private var status by mutableStateOf(LiveStatus.Connecting)
    val connecting get() = connection != null && !online && status == LiveStatus.Connecting && error == null
    var busy by mutableStateOf(false); private set
    /** Persisted with the outbox, per conversation, together with the reply target. */
    var draft: String
        get() = outbox.draft(selected)?.text.orEmpty()
        set(value) { selected?.let { outbox.setDraft(it, value, replyTargets[it]?.toString()) } }
    private val uploads = ChatUploads(app, viewModelScope, { api() }, { connection!!.deviceId }, ::chatError)
    val chatUploads: Map<String, List<ChatUpload>> get() = uploads.items
    var replyTargets by mutableStateOf<Map<String,Long>>(emptyMap()); private set
    private val chatSends = mutableMapOf<String,ChatSend>()
    private val outboxInFlight = outboxHub.inFlight
    private var outboxListeners: List<() -> Unit> = emptyList()
    private var outboxTimer: Job? = null
    private var outboxTimerAt = 0L
    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { viewModelScope.launch { connectivityReturned() } }
    }
    private val noticeOperations = mutableMapOf<String,String>()
    val defaultMinutes: Int get() = access.defaultMinutes
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
    private var eventCursor = 0L
    private val presenceMutex = Mutex()
    private var activityServerAt = 0L
    private var activitySnapshotAt = 0L
    fun activityNow(): Long = if (activityServerAt > 0) activityServerAt + (SystemClock.elapsedRealtime() - activitySnapshotAt).coerceAtLeast(0) else System.currentTimeMillis()
    private var reconnect: Job? = null
    private var pendingOpen: String? = null
    private var serverReadSync = false
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
        // Every failed attempt lands here with its next backoff step, so the timer re-arms itself.
        outboxListeners = listOf(outboxHub.onChange { armOutboxTimer(); adoptDirectOutbox() }, outboxHub.onDelivered(::deliveredElsewhere))
        runCatching { app.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(network) }
        // A room read on another device or from a notification: its row shows read at once.
        viewModelScope.launch { CompanionSignals.roomRead.collect { (room, at) -> if (connection != null) { roomChats.readElsewhere(room, at); invalidate(setOf("rooms")) } } }
        val initial = connection
        val initialCacheEpoch = cacheWriter.epoch
        val initialRoomWipes = roomChats.cacheWipes
        viewModelScope.launch(Dispatchers.IO) {
            val saved = cacheWriter.read()
            val savedRooms = roomWriter.read()
            // Start the room writer only after its blob was read; the outbox hub runs its own.
            launch { roomWriter.drain() }
            val restored = initial?.let { ChatHistoryCache(ChatHistoryCache.owner(it), saved) }
            val restoredRooms = initial?.let { RoomHistoryCache(ChatHistoryCache.owner(it), savedRooms) }
            withContext(Dispatchers.Main) {
                val owner = initial?.let(ChatHistoryCache::owner)
                if (owner != null && connection?.let(ChatHistoryCache::owner) == owner) {
                    outboxReady.await(); restoreDirectOutbox()
                    if (roomChats.cacheWipes == initialRoomWipes && restoredRooms != null) roomChats.restoreCache(restoredRooms)
                    pumpOutbox()
                } else if (connection == null) roomWriter.delete()
                if (initial != null && restored != null && connection?.let(ChatHistoryCache::owner) == ChatHistoryCache.owner(initial) && cacheWriter.epoch == initialCacheEpoch) {
                    if (!permissionsKnown && agents.isEmpty()) {
                        historyCache = restored; agents = historyCache.agents(); cachedOverview = agents.isNotEmpty()
                    } else if (can("agent_portal.read") && can("agent_portal.reveal_transcript") && portalAvailable) {
                        restored.reconcile(agents)
                        historyCache.agents().forEach { restored.remember(it, historyCache.events(it.getString("id")), historyCache.cursor(it.getString("id"))) }
                        historyCache = restored
                    }
                    persistChatCache(force = true)
                } else if (connection == null) cacheWriter.delete()
            }
            cacheWriter.drain()
        }
    }
    private fun persistChatCache(force: Boolean = false) = cacheWriter.persist(historyCache, force)
    private fun discardChatCache() {
        historyCache.clear(); cachedOverview = false
        cacheWriter.discard()
    }
    /** Also drops direct sends from the outbox, like the bubbles they back. */
    private fun clearTranscript() {
        outbox.clearWhere(drafts = false) { !it.startsWith(ConversationKey.ROOM_PREFIX) }
        selected = null; events = emptyList(); pendingChats = emptyMap(); chatSends.clear()
        eventsLoaded = false; eventCursor = 0; showingCachedTranscript = false; VisibleConversation.session = null
    }
    private fun api() = connection!!.let { Api(it.server, it.token, texts) }
    fun can(cap: String) = capabilities.contains(cap)
    fun fresh(now: Long = SystemClock.elapsedRealtime()) = online && lastSync > 0 && now - lastSync in 0..30_000
    fun reachable() = if (fresh() && can("agent_portal.manage") && can("agent_portal.reveal_transcript")) readyAgents(agents).filter { !it.optBoolean("daemon_session") || can("agent_messaging.manage") } else emptyList()
    /** Before the server answered, saved rooms open read-only from the offline cache. */
    internal fun canOpenRoom(room: JSONObject) = can("agent_messaging.reveal_content") || (!permissionsKnown && room.optBoolean("cached"))
    fun canReadSession(id: String) = connection != null && portalAvailable &&
        ((can("agent_portal.read") && can("agent_portal.reveal_transcript")) || showingSavedChats) && agents.any { it.optString("id") == id }
    fun overviewAvailable(): Boolean = !((!can("agent_portal.read") || !can("agent_portal.reveal_transcript")) && !showingSavedChats || !portalAvailable)
    fun overviewAgents(): List<JSONObject> = if (!overviewAvailable()) emptyList() else
        retainedChats(agents)
    fun canSpawn() = fresh() && portalAvailable && can("agent_messaging.manage") && can("agent_portal.manage") && can("agent_portal.read") && can("agent_portal.reveal_transcript")
    fun canSendSession(id: String?) = id != null && !(selected == id && showingCachedTranscript) && reachable().any { it.optString("id") == id }
    private fun refreshUnreadState() {
        val visible = permissionsKnown && can("agent_portal.read") && can("agent_portal.reveal_transcript") && portalAvailable
        val notify = if (permissionsKnown) notifications && portalAvailable && can("agent_portal.read") && can("agent_portal.reveal_transcript") else null
        unread.refresh(visible, notify, connection)
    }
    fun markConversationRead(id: String, replyCursor: Long) {
        if (!foreground || !fresh() || showingCachedTranscript || selected != id || !canReadSession(id) || replyCursor <= 0) return
        if (events.none { it.optString("type") == "assistant_message" && it.optLong("cursor") == replyCursor &&
                !it.optJSONObject("payload")?.optString("text").isNullOrBlank() }) return
        if (unreadStore.readCursor(id) >= replyCursor) return
        unreadStore.markRead(id, replyCursor)
        refreshUnreadState()
        if (serverReadSync) invalidate(setOf("agents"))
    }
    private fun failure(e: Exception) {
        if (e is CancellationException) throw e
        error = if (e is ApiException) e.message ?: texts.string(R.string.model_request_failed) else texts.string(R.string.model_connection_lost)
        online = false; status = LiveStatus.Offline
        if (e is ApiException && e.status == 401) { clearConnection(); error = texts.string(R.string.model_device_revoked) }
    }
    fun clearError() { error = null }
    fun clearNotice() { notice = null }
    fun pair(pairing: Pairing) {
        if (busy) return
        viewModelScope.launch {
            busy = true; error = null
            try {
                val result = Api(pairing.server, texts = texts).request("/pair", "POST", JSONObject().put("token", pairing.token).put("name", android.os.Build.MODEL))
                val c = Connection(pairing.server, result.getString("token"), result.getString("device_id"), result.optJSONObject("firebase"))
                store.save(c); connection = c; unreadStore.activate(c); unread.reset(); permissionsKnown = false
                discardChatCache(); historyCache = ChatHistoryCache(ChatHistoryCache.owner(c))
                outbox.reset(ChatHistoryCache.owner(c)); outboxHub.bind(ChatHistoryCache.owner(c)); roomChats.resetCache(ChatHistoryCache.owner(c)); replyTargets = emptyMap()
                configurePush(getApplication(), c); startLive()
            } catch (e: Exception) { failure(e) } finally { busy = false }
        }
    }
    fun setForeground(value: Boolean) {
        if (foreground == value) return
        foreground = value
        if (value) { connection?.let { configurePush(getApplication(), it) }; outbox.retryNow(); startLive() }
        else {
            stopLive()
            viewModelScope.launch { runCatching { updatePresence() } }
        }
    }
    private fun stopLive() {
        generation++; revision++; socketReady = false; online = false
        socket?.cancel(); socket = null
        maintenance?.cancel(); refreshJob?.cancel(); refreshJob = null; reconnect?.cancel(); outboxTimer?.cancel(); outboxTimer = null
        pendingScopes.clear(); VisibleConversation.session = null
    }
    private fun startLive() {
        stopLive()
        if (!foreground || connection == null) return
        status = if (reconnectAttempt > 0 || error != null) LiveStatus.Reconnecting else LiveStatus.Connecting
        val current = generation
        lastFrame = SystemClock.elapsedRealtime()
        socket = api().live(liveSocketListener(viewModelScope, { generation == current }, { foreground }, { frame ->
            when (frame) {
                LiveFrame.Hello -> { socketReady = true; invalidate() }
                is LiveFrame.Changed -> invalidate(frame.scopes)
                LiveFrame.Ping -> if (online && pendingScopes.isEmpty() && refreshJob?.isActive != true) lastSync = SystemClock.elapsedRealtime()
                is LiveFrame.RoomActivity -> roomChats.activity(frame)
            }
            lastFrame = SystemClock.elapsedRealtime()
        }) { revoked -> if (revoked) failure(ApiException(401, "Device revoked")) else scheduleReconnect() })
        maintenance = viewModelScope.launch {
            var presenceAt = 0L
            while (foreground && generation == current) {
                delay(5000)
                val now = SystemClock.elapsedRealtime()
                if (now - lastFrame >= 30_000) { scheduleReconnect(); break }
                if (socketReady && (selected != null || roomChats.selected != null) && now - presenceAt >= 20_000) {
                    presenceAt = now
                    try { updatePresence() } catch (e: Exception) { failure(e); scheduleReconnect() }
                }
            }
        }
    }
    private fun scheduleReconnect() {
        stopLive()
        if (!foreground || connection == null) return
        status = LiveStatus.Reconnecting
        val wait = reconnectDelay(reconnectAttempt)
        reconnectAttempt++
        reconnect = viewModelScope.launch { delay(wait); startLive() }
    }
    private fun invalidate(scopes: Set<String> = setOf("me", "agents", "approvals", "hosts", "rooms")) {
        if (!foreground || connection == null || !socketReady) return
        val known = scopes.intersect(setOf("me", "agents", "approvals", "hosts", "rooms"))
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
        if (current != generation || epoch != revision || !foreground) return false
        if (me != null) { serverReadSync = me.optInt("read_sync_protocol", 0) >= 1; roomChats.applyProtocols(RoomProtocols.from(me)) }
        if ("rooms" in scopes || me != null) {
            roomChats.refresh(client, caps, full = me != null) { current == generation && epoch == revision && foreground }
            if (current != generation || epoch != revision || !foreground) return false
        }
        if (me != null && !("agent_portal.read" in caps && "agent_portal.reveal_transcript" in caps)) {
            capabilities = caps; permissionsKnown = true; agents = emptyList()
            discardChatCache(); clearTranscript(); clearDirectDrafts()
            refreshUnreadState()
        }
        val loadApprovals = "approvals" in scopes || me != null
        val loadAgents = "agents" in scopes || me != null
        val requests = if (loadApprovals && "hosts.activate_insecure" in caps) client.request("/approvals") else null
        var portalDisabled = false
        val snapshot = if (loadAgents && "agent_portal.read" in caps) {
            try { client.request("/agents", "POST", JSONObject().put("read_cursors", unreadStore.readCursors(pendingOnly = serverReadSync)).apply { if (serverReadSync) put("sync_reads", true) }) }
            catch (e: ApiException) {
                if (e.status == 403 && current == generation && epoch == revision) { discardChatCache(); clearTranscript(); clearDirectDrafts(); agents = emptyList() }
                if (e.status == 503 && e.code == "agent_portal_disabled") { portalDisabled = true; null } else throw e
            }
        } else null
        val hostSnapshot = if (("hosts" in scopes || me != null) && "admin.read" in caps) client.request("/hosts") else null
        val id = selected
        var transcriptAllowed = "agent_portal.read" in caps && "agent_portal.reveal_transcript" in caps && !portalDisabled
        val nextEvents = if (loadAgents && id != null && transcriptAllowed) {
            val expectedReply = snapshot?.optJSONArray("agents")?.objects()?.firstOrNull { it.optString("id") == id }?.optLong("reply_cursor") ?: 0
            try { loadDirectHistory(client, id, expectedReply, events, eventCursor, eventsLoaded) }
            catch (e: ApiException) {
                if (e.status in setOf(403, 404, 410)) { transcriptAllowed = false; null } else throw e
            }
        } else null
        if (current != generation || epoch != revision || !foreground) return false
        capabilities = caps
        if ("admin.read" !in caps || "auth.read_metadata" !in caps) quotas.clear()
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
        if (loadApprovals) access.apply(requests)
        if (loadAgents) {
            agents = snapshot?.getJSONArray("agents")?.objects() ?: emptyList()
            activityServerAt = runCatching { java.time.Instant.parse(snapshot?.optString("generated_at")).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
            activitySnapshotAt = SystemClock.elapsedRealtime()
        }
        if (loadAgents && snapshot != null && "agent_portal.reveal_transcript" in caps && !portalDisabled) {
            if (!unreadStore.observeReplies(agents, unreadRevision, snapshot.optJSONObject("processed_read_cursors"))) pendingScopes.add("agents")
            if (serverReadSync && unreadStore.hasPendingReads()) pendingScopes.add("agents")
        }
        if (!transcriptAllowed) { discardChatCache(); clearTranscript() }
        else if (nextEvents != null && selected == id) {
            events = nextEvents.events; eventCursor = nextEvents.cursor; eventsLoaded = true; showingCachedTranscript = false
            if (id != null) pendingChats = pendingChats + (id to pendingChatsAfterRefresh(pendingChats[id] ?: emptyList(), nextEvents.events))
        }
        if (loadAgents && transcriptAllowed) {
            historyCache.reconcile(agents)
            if (nextEvents != null && selected == id) agents.firstOrNull { it.optString("id") == id }?.let { historyCache.remember(it, nextEvents.events, nextEvents.cursor) }
            persistChatCache()
        }
        val reconnected = !online
        if (reconnected) error = null
        status = if (!portalAvailable) LiveStatus.PortalDisabled else LiveStatus.Live
        online = socketReady; lastSync = SystemClock.elapsedRealtime(); reconnectAttempt = 0
        refreshUnreadState()
        if (reconnected && selected != null) viewModelScope.launch { runCatching { updatePresence() } }
        pendingOpen?.let { if (loadAgents) { pendingOpen = null; openSession(it) } }
        pumpOutbox()
        return true
    }
    private suspend fun updatePresence() = presenceMutex.withLock {
        val c = connection ?: return@withLock
        // An open room is reported like a chat (its id is a UUID too); the server then skips its pushes.
        val id = if (!foreground) null else (selected?.takeIf { can("agent_portal.reveal_transcript") }
            ?: roomChats.selected?.takeIf { can("agent_messaging.reveal_content") })
        VisibleConversation.session = id
        Api(c.server, c.token, texts).request("/device", "PATCH", JSONObject().put("visible_session_id", id ?: JSONObject.NULL))
    }
    fun refreshNow() { if (socketReady) invalidate() else startLive() }
    fun openSession(id: String) {
        if (!canReadSession(id)) { notice = texts.string(R.string.model_conversation_unavailable); return }
        roomChats.close()
        revision++
        selected = id; events = historyCache.events(id); eventCursor = historyCache.cursor(id); eventsLoaded = events.isNotEmpty(); showingCachedTranscript = eventsLoaded
        invalidate(setOf("agents"))
        viewModelScope.launch {
            try { updatePresence() } catch (e: Exception) { failure(e) }
        }
    }
    fun closeSession() {
        roomChats.close()
        revision++
        selected = null; events = emptyList(); eventCursor = 0; eventsLoaded = false; showingCachedTranscript = false; VisibleConversation.session = null
        invalidate(setOf("agents"))
        if (foreground && connection != null) viewModelScope.launch { runCatching { updatePresence() } }
    }
    fun follow(id: String, value: Boolean) { mutate { api().request("/agents/$id/follow", "PUT", JSONObject().put("followed", value)); follows = if (value) follows + id else follows - id } }
    fun replyTo(cursor: Long?) {
        val id = selected ?: return
        replyTargets = if (cursor == null) replyTargets - id else replyTargets + (id to cursor)
        outbox.setDraft(id, draft, cursor?.toString())
    }
    fun chatError(message:String) { error=message }
    /** The open room is reported as the visible conversation (after closeSession's own report), suppressing its pushes. */
    internal fun openRoom(room: JSONObject) {
        closeSession(); roomChats.open(room)
        connection?.let { cancelRoomNotification(getApplication(), it, room.getString("id")) }
        if (foreground && connection != null) viewModelScope.launch { runCatching { updatePresence() } }
    }
    internal fun roomSent(id: String, attachments: List<String>) {
        val key = "room:$id"
        chatUploads[key]?.filter { it.id in attachments }?.forEach { it.file.delete() }
        uploads.drop(key, attachments)
        refreshNow()
    }
    fun addChatFile(session:String, uri:android.net.Uri) = uploads.addFile(session, uri)
    fun addCapturedFile(session:String,file:java.io.File,name:String,mime:String) = uploads.addCaptured(session, file, name, mime)
    fun retryChatUpload(session:String,item:ChatUpload) = uploads.retry(session, item)
    fun removeChatUpload(session:String,id:String) = uploads.remove(session, id)
    suspend fun chatAttachmentInfo(session:String,id:String) = uploads.info(session, id)
    suspend fun downloadChatAttachment(session:String,id:String):java.io.File = uploads.download(session, id)
    fun saveChatAttachment(file:java.io.File,uri:android.net.Uri) {
        mutate { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            getApplication<Application>().contentResolver.openOutputStream(uri)?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: error(texts.string(R.string.model_cannot_save_file))
        };notice=texts.string(R.string.model_file_saved) }
    }
    fun resolveChatNotice(session:String,id:String) {
        val operation=noticeOperations.getOrPut(id) { UUID.randomUUID().toString() }
        mutate { api().request("/agents/$session/notices/resolve","POST",JSONObject().put("notice_id",id).put("client_event_id",operation)); notice=texts.string(R.string.model_marked_resolved) }
    }
    fun send(prompt: JSONObject? = null, choiceValue:String? = null) {
        if (busy) return
        val id = selected ?: return
        if (!canSendSession(id)) { error = texts.string(R.string.chat_agent_unreachable); return }
        val text = draft.trim(); val items=chatUploads[id] ?: emptyList()
        if(text.isEmpty() && items.isEmpty()) return
        if(items.any { it.state != "ready" }) { error=texts.string(R.string.model_pending_uploads); return }
        val metadata=JSONObject().put("attachments",JSONArray(items.map { it.id }))
        replyTargets[id]?.let { metadata.put("reply_to",it) }; choiceValue?.let { metadata.put("choice_value",it) }
        submitChat(chatSendIntent(chatSends.values, id, prompt, text, metadata))
    }
    fun retryChat(clientId: String) {
        val intent = chatSends[clientId] ?: return
        if (busy || selected != intent.session || !canSendSession(intent.session)) return
        submitChat(intent)
    }
    /** Retry and discard apply to sends this device still holds in its outbox. */
    fun canRetryChat(clientId: String?) = clientId != null && chatSends.containsKey(clientId)
    /** Drops a definitively failed send; its text returns to an empty composer. */
    fun discardChat(clientId: String) {
        val entry = outbox.entry(clientId)?.takeIf { it.failed && it.id !in outboxInFlight } ?: return
        val intent = chatSends.remove(clientId)
        outbox.remove(clientId)
        pendingChats = pendingChats + (entry.conversation to (pendingChats[entry.conversation] ?: emptyList()).filterNot { it.clientId == clientId })
        if (intent != null && outbox.draft(entry.conversation) == null) outbox.setDraft(entry.conversation, intent.text, null)
    }
    private fun submitChat(intent: ChatSend) {
        val id = intent.session
        val previous = pendingChats[id] ?: emptyList()
        val bubble = previous.firstOrNull { it.clientId == intent.uuid }?.copy(status = "sending")
            ?: PendingChat(intent.uuid, --localChatCursor, intent.text, intent.metadata, java.time.Instant.now().toString())
        pendingChats = pendingChats + (id to (previous.filterNot { it.clientId == intent.uuid } + bubble))
        chatSends[intent.uuid] = intent
        // Persisted before the request: a restart resends exactly this body and id.
        val entry = outbox.entry(intent.uuid)?.copy(failed = false, error = null)?.also { retry -> outbox.update(retry.id) { retry } }
            ?: intent.outboxEntry(bubble.createdAt).also(outbox::enqueue)
        val owner = connection
        mutate { deliverDirect(entry, owner, manual = true) }
    }
    /**
     * One attempt of a persisted direct send. A manual attempt rethrows failures
     * for [mutate] to report; an automatic one stays quiet unless access is gone.
     */
    private suspend fun deliverDirect(entry: OutboxEntry, owner: Connection?, manual: Boolean) {
        if (!outboxInFlight.add(entry.id)) return
        val id = entry.conversation
        try {
            if (!manual) updatePendingChat(id, entry.id, "sending")
            outboxWriter.flush()
            val c = connection?.takeIf { it == owner } ?: return
            val result = deliverOutboxEntry(Api(c.server, c.token, texts), entry)
            if (connection != owner) return
            val rejection = when (result) {
                is OutboxResult.Rejected -> result
                is OutboxResult.Accepted -> {
                    val response = result.response
                    val messageId = (response.opt("message_id") as? String) ?: (response.opt("operation_id") as? String)
                    if (messageId == null) OutboxResult.Rejected(IllegalStateException(texts.string(R.string.model_delivery_unconfirmed)), SendFailure.Transient)
                    else {
                        outbox.remove(entry.id)
                        val failed = response.optString("status") in setOf("canceled", "dead")
                        updatePendingChat(id, entry.id, if (failed) "failed" else "queued", messageId)
                        val intent = chatSends.remove(entry.id) ?: chatSendFromOutbox(entry)
                        if (!failed && intent != null) {
                            val draftNow = outbox.draft(id)
                            if (draftNow?.text?.trim() == intent.text) outbox.setDraft(id, "", null)
                            else if (draftNow != null) outbox.setDraft(id, draftNow.text, null)
                            val items = chatUploads[id] ?: emptyList()
                            val sentIds = JSONObject(intent.metadata).optJSONArray("attachments")?.strings() ?: emptySet()
                            uploads.drop(id, sentIds)
                            replyTargets = replyTargets - id
                            items.filter { it.id in sentIds }.forEach { it.file.delete() }; follows = follows + id
                        }
                        if (!manual) refreshNow()
                        null
                    }
                }
            }
            if (rejection != null) {
                outbox.update(entry.id) { it.afterFailure(rejection, SystemClock.elapsedRealtime()) }
                updatePendingChat(id, entry.id, if (rejection.failure == SendFailure.Definitive) "failed" else "unconfirmed")
                if (manual) throw rejection.error
                if ((rejection.error as? ApiException)?.status == 401) failure(rejection.error)
                else if (rejection.failure == SendFailure.Definitive) error = rejection.error.message ?: texts.string(R.string.model_not_delivered)
            }
        } finally { outboxInFlight.remove(entry.id) }
    }
    /** Rebuilds bubbles, retry intents and reply targets of persisted direct sends after a restart. */
    private fun restoreDirectOutbox() {
        adoptDirectOutbox()
        outbox.drafts.forEach { (key, draft) ->
            if (!key.startsWith(ConversationKey.ROOM_PREFIX) && key !in replyTargets) draft.replyTo?.toLongOrNull()?.let { replyTargets = replyTargets + (key to it) }
        }
    }
    /** Bubbles and retry intents for direct sends this model does not know yet (restored, or queued by a notification reply). */
    private fun adoptDirectOutbox() {
        outbox.entries.filter { !it.room && !chatSends.containsKey(it.id) }.forEach { entry ->
            val intent = chatSendFromOutbox(entry) ?: return@forEach
            chatSends[entry.id] = intent
            val bubble = PendingChat(entry.id, --localChatCursor, intent.text, intent.metadata, entry.createdAt, if (entry.failed) "failed" else "unconfirmed")
            pendingChats = pendingChats + (entry.conversation to ((pendingChats[entry.conversation] ?: emptyList()) + bubble))
        }
    }
    /** A notification action delivered [entry]: its bubble turns queued and the views refresh. */
    private fun deliveredElsewhere(entry: OutboxEntry, response: JSONObject) {
        if (!entry.room) {
            chatSends.remove(entry.id)
            val messageId = (response.opt("message_id") as? String) ?: (response.opt("operation_id") as? String)
            updatePendingChat(entry.conversation, entry.id, if (response.optString("status") in setOf("canceled", "dead")) "failed" else "queued", messageId)
        }
        if (foreground && connection != null) refreshNow()
    }
    private fun clearDirectDrafts() {
        outbox.clearWhere { !it.startsWith(ConversationKey.ROOM_PREFIX) }
        replyTargets = emptyMap()
    }
    /**
     * Automatic resends while in the foreground and live: per conversation the oldest
     * unconfirmed send whose backoff is due, then a timer for the next due one.
     */
    private fun pumpOutbox() {
        outboxTimer?.cancel(); outboxTimer = null
        val owner = connection
        if (!foreground || owner == null) return
        val now = SystemClock.elapsedRealtime()
        if (fresh()) outbox.entries.filter { !it.room && !it.failed }.groupBy { it.conversation }.forEach { (session, queue) ->
            val entry = queue.first()
            if (entry.id in outboxInFlight || entry.nextAttemptAt > now || busy || !canSendSession(session)) return@forEach
            viewModelScope.launch { deliverDirect(entry, owner, manual = false) }
        }
        roomChats.pump(::roomSent)
        armOutboxTimer()
    }
    /** Schedules [pumpOutbox] for the earliest pending backoff step, unless an earlier timer is armed. */
    private fun armOutboxTimer() {
        if (!foreground || connection == null) return
        val now = SystemClock.elapsedRealtime()
        val due = outbox.entries.filter { !it.failed && it.nextAttemptAt > now }.minOfOrNull { it.nextAttemptAt } ?: return
        if (outboxTimer?.isActive == true && outboxTimerAt <= due) return
        outboxTimer?.cancel()
        outboxTimerAt = due
        outboxTimer = viewModelScope.launch { delay(due - now); outboxTimer = null; pumpOutbox() }
    }
    /** The default network is back: unconfirmed sends retry now instead of waiting for their backoff. */
    private fun connectivityReturned() {
        if (connection == null || outbox.entries.none { !it.failed }) return
        outbox.retryNow()
        if (foreground && reconnect?.isActive == true) { reconnectAttempt = 0; startLive() } else pumpOutbox()
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
                val result = Api(c.server, c.token, texts).request("/daemon-sessions", "POST", body)
                if (connection?.deviceId != c.deviceId) return@launch
                store.clearPendingStart(); pendingStart = null
                pendingOpen = result.getString("session_id")
                notice = texts.string(R.string.model_start_queued)
                onSuccess(); refreshNow()
            } catch (e: Exception) {
                if (e is ApiException && e.status in setOf(400, 403, 404, 409)) { store.clearPendingStart(); pendingStart = null }
                failure(e); if (connection != null) refreshNow()
            } finally { busy = false }
        }
    }
    fun decide(id: Long, approve: Boolean, minutes: Int, onSuccess: () -> Unit = {}) {
        if (!fresh() || approvals.none { it.optLong("id") == id && liveApproval(it, System.currentTimeMillis()) }) {
            error = texts.string(R.string.model_request_unavailable); refreshNow(); return
        }
        mutate {
            // The server locks and rechecks pending state and expiry at decision time.
            api().request("/approvals/$id/${if (approve) "approve" else "deny"}", "POST", JSONObject().put("duration_minutes", minutes))
            access.decided(id)
            notice = if (approve) texts.string(R.string.model_access_allowed, durationLabel(texts, minutes)) else texts.string(R.string.model_access_denied)
            onSuccess()
        }
    }
    fun closeWindow(hostId: Long) {
        if (!can("hosts.activate_insecure") || !fresh() || liveFleetWindow(fleetWindow, System.currentTimeMillis()) ||
            activeWindows.none { it.optLong("host_id") == hostId && liveWindow(it, System.currentTimeMillis()) }) {
            error = texts.string(R.string.model_window_unavailable); refreshNow(); return
        }
        mutate {
            api().request("/hosts/$hostId/insecure/disable", "POST", JSONObject())
            access.windowClosed(hostId)
            notice = texts.string(R.string.model_host_window_closed)
        }
    }
    fun closeFleetWindow(onSuccess: () -> Unit = {}) {
        if (!can("hosts.activate_insecure") || !fresh() || !liveFleetWindow(fleetWindow, System.currentTimeMillis())) {
            error = texts.string(R.string.model_fleet_unavailable); refreshNow(); return
        }
        mutate {
            val result = api().request("/insecure/window/close", "POST", JSONObject())
            notice = if (result.optBoolean("closed")) texts.string(R.string.model_fleet_closed) else texts.string(R.string.model_window_changed)
            onSuccess()
        }
    }
    fun updateNotifications(value: Boolean) { mutate {
        api().request("/device", "PATCH", JSONObject().put("notifications", value))
        notifications = value; refreshUnreadState()
    } }
    fun logout() { mutate { api().request("/device", "DELETE"); clearConnection() } }
    private fun clearConnection() {
        roomChats.clear()
        discardChatCache()
        showingCachedTranscript = false; eventCursor = 0; eventsLoaded = false
        uploads.clear(); outbox.clear(); replyTargets=emptyMap(); chatSends.clear(); outboxInFlight.clear(); noticeOperations.clear()
        quotas.clear()
        store.clear(); connection = null; selected = null; events = emptyList(); pendingChats = emptyMap(); agents = emptyList(); hosts = emptyList(); pendingStart = null; access.clear(); capabilities = emptySet()
        serverReadSync = false; unreadStore.clear(); unread.reset(); permissionsKnown = false
        syncUnreadNotifications(getApplication(), null, emptySet())
        online = false; lastSync = 0; reconnectAttempt = 0; pendingOpen = null; highlightApproval = null; pendingRoomLink = null
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
    /** `orchestrator://chat/room:<id>`: opened by the shell once the room list contains it. */
    var pendingRoomLink by mutableStateOf<String?>(null); private set
    fun openRoomLink(roomId: String) { if (connection != null) { pendingRoomLink = roomId; refreshNow() } }
    fun clearRoomLink() { pendingRoomLink = null }
    fun notification(kind: String?, target: String?) {
        if (connection == null) return
        if (kind == "unread") {
            // A single unread chat opens directly; several fall back to the list.
            val only = target?.takeIf { runCatching { UUID.fromString(it) }.isSuccess } ?: unreadSessions.singleOrNull()
            closeSession()
            if (only != null) { online = false; pendingOpen = only }
            refreshNow(); return
        }
        if (target == null) return
        online = false
        if (kind == "approval") { closeSession(); highlightApproval = target }
        else if (runCatching { UUID.fromString(target) }.isSuccess) { closeSession(); pendingOpen = target; refreshNow() }
    }
    override fun onCleared() {
        unreadPreferences.unregisterOnSharedPreferenceChangeListener(unreadListener)
        runCatching { getApplication<Application>().getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(network) }
        outboxListeners.forEach { it() }
        cacheWriter.close(); roomWriter.close(); stopLive(); super.onCleared()
    }
}
