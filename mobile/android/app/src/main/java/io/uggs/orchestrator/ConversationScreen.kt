package io.uggs.orchestrator

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable internal fun ChatScreen(model: CompanionModel, agent: JSONObject?, fresh: Boolean) {
    key(model.selected) { Conversation(model, agent, fresh) }
}

@Composable private fun Conversation(model: CompanionModel, agent: JSONObject?, fresh: Boolean) {
    val sessionId = remember { model.selected }
    val prompt = agent?.optJSONObject("pending_prompt")
    val chatEvents = model.chatEvents
    val notices = agent?.optJSONArray("notices")?.objects().orEmpty()
    val rows = remember(chatEvents, agent) { buildTimeline(portalTimelineEntries(chatEvents, notices, prompt)) }
    val activeNoticeIds = notices.map { it.optString("id") }.toSet()
    val receipts = remember(chatEvents) { deliveryIndex(chatEvents) }
    val latestAssistant = rows.filterIsInstance<TimelineItem.Bubble>().lastOrNull { it.message.rawKind == "assistant_message" }
    val latestReplyCursor = (latestAssistant?.message?.key as? MessageKey.PortalEvent)?.cursor ?: 0
    val expectedReplyCursor = agent?.optLong("reply_cursor") ?: 0
    val agentName = agent?.let(::agentTitle) ?: "Agent"
    val working = fresh && !model.showingCachedTranscript && agent != null && chatAgentStatus(agent, model.activityNow(), fresh) == ChatAgentStatus.WORKING
    val empty = rows.none { it is TimelineItem.Bubble || it is TimelineItem.Decision } && prompt == null
    val list = rememberLazyListState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> foreground = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val scope = rememberCoroutineScope()
    val writable = fresh && model.canSendSession(model.selected)
    var followLatest by remember { mutableStateOf(true) }
    var newMessages by remember { mutableStateOf(false) }
    var autoScrolling by remember { mutableStateOf(false) }
    // The newest row the reader has seen at the end of the list; "New messages" counts from here.
    var anchorKey by remember { mutableStateOf<String?>(null) }
    val currentRows by rememberUpdatedState(rows)
    var expandedRuns by remember { mutableStateOf(emptySet<String>()) }
    var highlight by remember { mutableStateOf<String?>(null) }
    var transient by remember { mutableStateOf<String?>(null) }
    val notLoaded = stringResource(R.string.chat_quote_not_loaded)
    LaunchedEffect(highlight) { if (highlight != null) { delay(1600); highlight = null } }
    LaunchedEffect(transient) { if (transient != null) { delay(2500); transient = null } }
    // rows, then the current question, the empty state, the working indicator and "end".
    val endIndex = rows.size + (if (prompt != null) 1 else 0) + (if (empty) 1 else 0) + (if (working) 1 else 0)
    suspend fun latest(animate: Boolean) {
        autoScrolling = true
        try {
            if (animate) list.animateScrollToItem(endIndex) else list.scrollToItem(endIndex)
            followLatest = true; newMessages = false
        } finally { autoScrolling = false }
    }
    fun jumpTo(key: String) {
        val index = rows.indexOfFirst { it.key == key }
        if (index < 0) transient = notLoaded
        else scope.launch { list.animateScrollToItem(index); highlight = key }
    }
    LaunchedEffect(list) {
        var previous: Pair<Int, Int>? = null
        var previousHeight: Int? = null
        // Read one completed layout: requested scroll position can change before
        // canScrollForward catches up, which otherwise mistakes a jump up for the end.
        snapshotFlow { list.layoutInfo }.collect { layout ->
            val first = layout.visibleItemsInfo.firstOrNull()
            val last = layout.visibleItemsInfo.lastOrNull()
            val position = first?.let { it.index to it.offset }
            val atEnd = last == null || (last.index == layout.totalItemsCount - 1 && last.offset + last.size <= layout.viewportEndOffset)
            val resized = previousHeight != layout.viewportSize.height
            val moved = previous != null && position != previous
            previous = position
            previousHeight = layout.viewportSize.height
            if (atEnd) { followLatest = true; newMessages = false; anchorKey = currentRows.lastOrNull()?.key }
            // Schedule the next layout instead of forcing a remeasure inside this one.
            // Resizing for the keyboard should retain the current follow/reading choice.
            else if (resized && followLatest) list.requestScrollToItem(layout.totalItemsCount - 1)
            else if (!resized && moved && !autoScrolling) followLatest = false
        }
    }
    // Only a new message or question raises "New messages"; status rows and the
    // working indicator merely keep a follower pinned to the end.
    val lastMessageKey = rows.lastOrNull { it is TimelineItem.Bubble || it is TimelineItem.Decision }?.key
    LaunchedEffect(lastMessageKey, prompt?.optString("id")) {
        if (followLatest) latest(false) else newMessages = true
    }
    LaunchedEffect(rows.lastOrNull()?.key, working) { if (followLatest) latest(false) }
    // A snapshot/open is not a read receipt. Wait for the current assistant
    // bubble to appear in a completed layout at the latest position while resumed.
    LaunchedEffect(sessionId, latestReplyCursor, expectedReplyCursor, foreground, fresh, model.showingCachedTranscript) {
        if (sessionId == null || !foreground || !fresh || model.showingCachedTranscript || latestReplyCursor <= 0 || latestReplyCursor < expectedReplyCursor) return@LaunchedEffect
        snapshotFlow { list.layoutInfo to list.isScrollInProgress }.collect { (layout, scrolling) ->
            val last = layout.visibleItemsInfo.lastOrNull()
            val assistant = layout.visibleItemsInfo.firstOrNull { it.key == latestAssistant?.key }
            val atEnd = last?.key == "end" && last.offset + last.size <= layout.viewportEndOffset
            val rendered = assistant != null && assistant.offset < layout.viewportEndOffset && assistant.offset + assistant.size > layout.viewportStartOffset
            if (atEnd && rendered && !scrolling && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) &&
                model.selected == sessionId && agent?.optString("id") == sessionId && model.canReadSession(sessionId)) {
                model.markConversationRead(sessionId, latestReplyCursor)
            }
        }
    }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        if (model.showingCachedTranscript) Text(
            if (fresh) "Saved messages · Updating from server…" else "Saved messages · Waiting for server…",
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer).padding(10.dp).testTag("cached-history"),
            style = MaterialTheme.typography.labelMedium,
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                Modifier.fillMaxSize().testTag("conversation"), state = list,
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.Bottom,
            ) {
                timelineItems(rows, expandedRuns, { key -> expandedRuns = if (key in expandedRuns) expandedRuns - key else expandedRuns + key },
                    decision = { DecisionCard(it.prompt, false, history = true) {} }) { item ->
                    MessageBubble(model, sessionId ?: "", item, deliveryLabel(item.source, receipts, agent, fresh && !model.showingCachedTranscript), agentName, writable,
                        if (fresh && !model.showingCachedTranscript) activeNoticeIds else null, fresh, highlight == item.key, ::jumpTo)
                }
                if (prompt != null) item(key = "question:" + prompt.optString("id")) {
                    prompt.optJSONArray("attachments")?.strings()?.forEach { id -> if(sessionId != null) ChatAttachment(model,sessionId,id) }
                    DecisionCard(prompt, writable && !model.busy) { option -> model.draft = option; followLatest = true; model.send(prompt, option) }
                }
                if (empty) item(key = "empty") {
                    Column(Modifier.fillMaxWidth().padding(vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                            Box(Modifier.padding(18.dp)) { CompanionIcon(CompanionSymbol.Chat, tint = MaterialTheme.colorScheme.primary) }
                        }
                        Text("What do you need?", style = MaterialTheme.typography.titleMedium)
                        Text("Send a message to this agent.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (working) item(key = "typing") { TypingIndicator(stringResource(R.string.chat_agent_working, agentName)) }
                item(key = "end") { Spacer(Modifier.height(1.dp)) }
            }
            transient?.let { message ->
                Surface(Modifier.align(Alignment.TopCenter).padding(top = 8.dp), shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.inverseSurface, contentColor = MaterialTheme.colorScheme.inverseOnSurface) {
                    Text(message, Modifier.padding(horizontal = 14.dp, vertical = 10.dp), style = MaterialTheme.typography.bodyMedium)
                }
            }
            if (newMessages) {
                val unseen = unseenSince(rows, anchorKey)
                NewMessagesPill(unseen?.count, onClick = {
                    scope.launch {
                        if (unseen == null) latest(true)
                        else {
                            newMessages = false; anchorKey = rows.lastOrNull()?.key
                            autoScrolling = true
                            try { list.animateScrollToItem(unseen.firstIndex) } finally { autoScrolling = false }
                        }
                    }
                }, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp))
            }
        }
        if (!writable) Text(
            if (!fresh) (if (model.connecting) "Connecting — draft kept" else "Reconnecting — draft kept") else agent?.takeIf { it.optBoolean("daemon_session") }?.let { remoteStatus(it.optString("remote_status")) } ?: "Agent is no longer reachable",
            Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Column(Modifier.imePadding()) {
            val buttonsOnly = prompt?.optString("answer_mode") == "buttons"
            if (!buttonsOnly) {
                model.replyTargets[sessionId]?.let { cursor ->
                    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 60.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        ReplyQuote(replyPreview(model.events, cursor, agentName), Modifier.weight(1f))
                        IconButton(onClick = { model.replyTo(null) }) { CompanionIcon(CompanionSymbol.Close, "Cancel reply") }
                    }
                }
            }
            val composer: @Composable (() -> Unit, () -> Unit) -> Unit = { attach, camera ->
                if (!buttonsOnly) {
                    val hasAttachments = !(model.chatUploads[sessionId].isNullOrEmpty())
                    ChatComposer(model.draft, { model.draft = it }, if (prompt != null) "Your answer" else "Message",
                        canSend = writable && !model.busy && (model.draft.isNotBlank() || hasAttachments), sending = model.busy,
                        mediaActions = {
                            if (sessionId != null && model.can("agent_portal.manage")) {
                                IconButton(onClick = attach, enabled = writable && !model.busy) { CompanionIcon(CompanionSymbol.Attach, "Attach") }
                                if (model.draft.isEmpty()) IconButton(onClick = camera, enabled = writable && !model.busy) { CompanionIcon(CompanionSymbol.Camera, "Take photo") }
                            }
                        }) {
                        followLatest = true; newMessages = false
                        scope.launch { latest(true) }; model.send(prompt)
                    }
                } else if (sessionId != null && model.can("agent_portal.manage")) {
                    // Button-only answers may still carry media; keep pending uploads reachable.
                    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.End) {
                        IconButton(onClick = attach, enabled = writable && !model.busy) { CompanionIcon(CompanionSymbol.Attach, "Attach") }
                        IconButton(onClick = camera, enabled = writable && !model.busy) { CompanionIcon(CompanionSymbol.Camera, "Take photo") }
                    }
                }
            }
            // Keep capture launchers and an active recorder alive when prompt modes change.
            if (sessionId != null && model.can("agent_portal.manage")) ChatUploadControls(model, sessionId, writable && !model.busy, composer)
            else composer({}, {})
        }
    }
}

@Composable private fun MessageBubble(
    model: CompanionModel, session: String, item: TimelineItem.Bubble, delivery: String?, agentName: String, writable: Boolean,
    activeNoticeIds: Set<String>?, fresh: Boolean, highlighted: Boolean, jumpTo: (String) -> Unit,
) {
    val message = item.message
    val payload = item.source.optJSONObject("payload") ?: JSONObject()
    val text = message.text
    val severity = message.severity
    val noticeId = message.noticeId
    val resolved = noticeId != null && activeNoticeIds != null && noticeId !in activeNoticeIds
    // Notice previews have no transcript cursor; they keep the historical "bubble:0" tag.
    val cursor = (message.key as? MessageKey.PortalEvent)?.cursor ?: 0L
    val replyable = writable && cursor > 0
    val colors = bubbleColors(item.own, severity)
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var selecting by remember(item.key) { mutableStateOf(false) }
    val copyLabel = stringResource(R.string.chat_copy)
    val selectLabel = stringResource(R.string.chat_select_text)
    val reply = if (replyable) ({ model.replyTo(cursor) }) else null
    val actions = buildList {
        if (reply != null) add(BubbleAction("Reply", CompanionSymbol.Reply, reply))
        if (text.isNotBlank()) {
            add(BubbleAction(copyLabel) { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(copyLabel, text))) } })
            add(BubbleAction(selectLabel) { selecting = true })
        }
    }
    ChatBubble(item, "bubble:$cursor", colors, actions, reply, highlighted) {
        if (severity != null) Text(
            severity.replaceFirstChar { it.uppercase() } + if (resolved) " · Resolved" else "",
            Modifier.padding(horizontal = 8.dp, vertical = 4.dp).testTag("message-severity:$cursor"),
            style = MaterialTheme.typography.labelLarge, color = colors.content,
        )
        (message.replyTo as? MessageKey.PortalEvent)?.let { target ->
            ReplyQuote(replyPreview(model.events, target.cursor, agentName), accent = if (item.own) colors.content else MaterialTheme.colorScheme.primary,
                onClick = { jumpTo(target.itemKey()) })
        }
        message.attachments.forEach { id -> ChatAttachment(model, session, id) }
        if (text.isNotBlank()) BubbleText(text, markdown = !item.own, colors, selecting) { selecting = false }
        if (message.localStatus == "unconfirmed" && cursor < 0) {
            TextButton(onClick = { message.localId?.let(model::retryChat) }, enabled = writable && !model.busy) { Text("Retry", color = colors.content) }
        }
        if (noticeId != null && !resolved) TextButton(
            onClick = { model.resolveChatNotice(session, noticeId) },
            enabled = fresh && activeNoticeIds?.contains(noticeId) == true && model.can("agent_portal.manage") && !model.busy,
            modifier = Modifier.align(Alignment.End).testTag("resolve-notice:$noticeId"),
        ) { Text("Resolve", color = colors.content) }
        BubbleFooter(item, colors) {
            if (delivery != null) Text(delivery,
                Modifier.widthIn(max = 180.dp).testTag("delivery:" + payload.optString("message_id")),
                style = MaterialTheme.typography.labelSmall, color = colors.secondary)
        }
    }
}

/** The current question is answerable; earlier questions stay in the history read-only. */
@Composable internal fun DecisionCard(prompt: JSONObject, enabled: Boolean, history: Boolean = false, answer: (String) -> Unit) {
    Surface(Modifier.fillMaxWidth().padding(top = if (history) 10.dp else 18.dp, bottom = 8.dp), shape = MaterialTheme.shapes.large,
        color = if (history) MaterialTheme.colorScheme.surfaceContainer else MaterialTheme.colorScheme.primaryContainer) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(if (history) stringResource(R.string.chat_earlier_question) else "Your decision", style = MaterialTheme.typography.labelLarge,
                color = if (history) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary)
            Text(prompt.optString("question"), style = MaterialTheme.typography.titleMedium)
            val choices = prompt.optJSONArray("choices")?.objects()?.takeIf { it.isNotEmpty() } ?: (prompt.optJSONArray("options")?.strings() ?: emptySet()).map { JSONObject().put("label",it).put("value",it) }
            if(prompt.optString("answer_mode") != "text") choices.forEach { choice ->
                if (history) Text("• " + choice.optString("label"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else OutlinedButton(onClick = { answer(choice.getString("value")) }, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(choice.getString("label")) }
            }
        }
    }
}
