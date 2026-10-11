package io.uggs.orchestrator

import android.text.format.DateFormat
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable internal fun ChatScreen(model: CompanionModel, agent: JSONObject?, fresh: Boolean) {
    key(model.selected) { Conversation(model, agent, fresh) }
}

@Composable private fun Conversation(model: CompanionModel, agent: JSONObject?, fresh: Boolean) {
    val sessionId = remember { model.selected }
    val prompt = agent?.optJSONObject("pending_prompt")
    val rows = remember(model.events) { chatRows(model.events) }
    val receipts = remember(model.events) { deliveryIndex(model.events) }
    val latestAssistant = rows.filterIsInstance<ChatRow.Message>().lastOrNull { it.event.optString("type") == "assistant_message" }
    val latestReplyCursor = latestAssistant?.event?.optLong("cursor") ?: 0
    val expectedReplyCursor = agent?.optLong("reply_cursor") ?: 0
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
    suspend fun latest(animate: Boolean) {
        autoScrolling = true
        try {
            val end = rows.size + if (prompt != null) 1 else 0
            if (animate) list.animateScrollToItem(end) else list.scrollToItem(end)
            followLatest = true; newMessages = false
        } finally { autoScrolling = false }
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
            if (atEnd) { followLatest = true; newMessages = false }
            // Schedule the next layout instead of forcing a remeasure inside this one.
            // Resizing for the keyboard should retain the current follow/reading choice.
            else if (resized && followLatest) list.requestScrollToItem(layout.totalItemsCount - 1)
            else if (!resized && moved && !autoScrolling) followLatest = false
        }
    }
    LaunchedEffect(rows.lastOrNull()?.key, prompt?.optString("id")) {
        if (followLatest) latest(false) else newMessages = true
    }
    // A snapshot/open is not a read receipt. Wait for the current assistant
    // bubble to appear in a completed layout at the latest position while resumed.
    LaunchedEffect(sessionId, latestReplyCursor, expectedReplyCursor, foreground, fresh) {
        if (sessionId == null || !foreground || !fresh || latestReplyCursor <= 0 || latestReplyCursor < expectedReplyCursor) return@LaunchedEffect
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
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                Modifier.fillMaxSize().testTag("conversation"), state = list,
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.Bottom,
            ) {
                items(rows, key = { it.key }) { row ->
                    when (row) {
                        is ChatRow.Day -> Box(Modifier.fillMaxWidth().padding(vertical = 18.dp), contentAlignment = Alignment.Center) {
                            Text(dayLabel(row.date), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        is ChatRow.Message -> MessageBubble(model, sessionId ?: "", row, deliveryLabel(row.event, receipts, agent, fresh))
                    }
                }
                if (prompt != null) item(key = "question:" + prompt.optString("id")) {
                    prompt.optJSONArray("attachments")?.strings()?.forEach { id -> if(sessionId != null) ChatAttachment(model,sessionId,id) }
                    DecisionCard(prompt, writable && !model.busy) { option -> model.draft = option; followLatest = true; model.send(prompt, option) }
                }
                if (rows.isEmpty() && prompt == null) item(key = "empty") {
                    Column(Modifier.fillMaxWidth().padding(vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                            Box(Modifier.padding(18.dp)) { CompanionIcon(CompanionSymbol.Chat, tint = MaterialTheme.colorScheme.primary) }
                        }
                        Text("What do you need?", style = MaterialTheme.typography.titleMedium)
                        Text("Send a message to this agent.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                item(key = "end") { Spacer(Modifier.height(1.dp)) }
            }
            if (newMessages) FilledTonalButton(
                onClick = { scope.launch { latest(true) } },
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp).heightIn(min = 48.dp),
                elevation = ButtonDefaults.filledTonalButtonElevation(defaultElevation = 3.dp),
            ) {
                CompanionIcon(CompanionSymbol.Down)
                Spacer(Modifier.width(8.dp)); Text("New messages")
            }
        }
        if (!writable) Text(
            if (!fresh) (if (model.connecting) "Connecting — draft kept" else "Reconnecting — draft kept") else agent?.takeIf { it.optBoolean("daemon_session") }?.let { remoteStatus(it.optString("remote_status")) } ?: "Agent is no longer reachable",
            Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        agent?.optJSONArray("notices")?.objects()?.forEach { notice ->
            Row(Modifier.fillMaxWidth().padding(horizontal=12.dp), verticalAlignment=Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text("Needs you · ${notice.optString("severity")}",style=MaterialTheme.typography.labelMedium); Text(notice.optString("summary"),style=MaterialTheme.typography.bodySmall) }
                TextButton(onClick={ model.resolveChatNotice(sessionId ?: "",notice.getString("id")) },enabled=fresh && model.can("agent_portal.manage") && !model.busy) { Text("Resolve") }
            }
        }
        model.replyTargets[sessionId]?.let { cursor -> Row(Modifier.padding(horizontal=12.dp)) { Text("Reply to message #$cursor",style=MaterialTheme.typography.bodySmall); TextButton(onClick={model.replyTo(null)}) {Text("Cancel")} } }
        if(sessionId != null && model.can("agent_portal.manage")) ChatUploadControls(model,sessionId,writable && !model.busy)
        if(prompt?.optString("answer_mode") != "buttons") MessageComposer(model.draft, { model.draft = it }, prompt != null, writable, model.busy, !(model.chatUploads[sessionId].isNullOrEmpty())) {
            followLatest = true; newMessages = false
            scope.launch { latest(true) }; model.send(prompt)
        }
    }
}

@Composable private fun MessageBubble(model: CompanionModel, session: String, row: ChatRow.Message, delivery: String?) {
    val own = row.event.optString("type") == "user_message"
    val shape = RoundedCornerShape(
        topStart = if (!own && row.joinsPrevious) 6.dp else 22.dp,
        topEnd = if (own && row.joinsPrevious) 6.dp else 22.dp,
        bottomEnd = if (own) 6.dp else 22.dp,
        bottomStart = if (!own) 6.dp else 22.dp,
    )
    val use24Hour = DateFormat.is24HourFormat(LocalContext.current)
    BoxWithConstraints(Modifier.fillMaxWidth().padding(top = if (row.joinsPrevious) 3.dp else 10.dp)) {
        val bubbleWidth = maxWidth * .85f
        Row(Modifier.fillMaxWidth(), horizontalArrangement = if (own) Arrangement.End else Arrangement.Start) {
            Column(Modifier.widthIn(max = bubbleWidth), horizontalAlignment = if (own) Alignment.End else Alignment.Start) {
                Surface(shape = shape, color = if (own) MessageBlue else MaterialTheme.colorScheme.surfaceContainerHigh, contentColor = if (own) Color.White else MaterialTheme.colorScheme.onSurface) {
                    SelectionContainer {
                        if(row.event.optString("type") == "assistant_message") ChatMarkdown(row.event.getJSONObject("payload").optString("text"),Modifier.padding(horizontal=15.dp,vertical=10.dp))
                        else Text(row.event.getJSONObject("payload").optString("text"), Modifier.padding(horizontal = 15.dp, vertical = 10.dp), style = MaterialTheme.typography.bodyLarge)
                    }
                }
                row.event.getJSONObject("payload").optLong("reply_to").takeIf { it > 0 }?.let { Text("Reply to message #$it",style=MaterialTheme.typography.bodySmall) }
                row.event.getJSONObject("payload").optJSONArray("attachments")?.strings()?.forEach { id -> ChatAttachment(model,session,id) }
                Row { TextButton(onClick={model.replyTo(row.event.optLong("cursor"))}) {Text("Reply")}; val clipboard=androidx.compose.ui.platform.LocalClipboardManager.current; TextButton(onClick={clipboard.setText(androidx.compose.ui.text.AnnotatedString(row.event.getJSONObject("payload").optString("text")))}) {Text("Copy")} }
                if (delivery != null) Text(delivery,
                    Modifier.padding(horizontal = 9.dp, vertical = 3.dp).testTag("delivery:" + row.event.optJSONObject("payload")?.optString("message_id")),
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (!row.joinsNext) eventTime(row.event)?.let {
                    Text(timeLabel(it, use24Hour), Modifier.padding(horizontal = 9.dp, vertical = 5.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable private fun DecisionCard(prompt: JSONObject, enabled: Boolean, answer: (String) -> Unit) {
    Surface(Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 8.dp), shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.primaryContainer) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Your decision", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Text(prompt.optString("question"), style = MaterialTheme.typography.titleMedium)
            val choices = prompt.optJSONArray("choices")?.objects()?.takeIf { it.isNotEmpty() } ?: (prompt.optJSONArray("options")?.strings() ?: emptySet()).map { JSONObject().put("label",it).put("value",it) }
            if(prompt.optString("answer_mode") != "text") choices.forEach { choice ->
                OutlinedButton(onClick = { answer(choice.getString("value")) }, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(choice.getString("label")) }
            }
        }
    }
}

@Composable private fun MessageComposer(draft: String, change: (String) -> Unit, answering: Boolean, writable: Boolean, sending: Boolean, hasAttachments:Boolean = false, send: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.background) {
        Surface(
            modifier = Modifier.fillMaxWidth().imePadding().padding(horizontal = 12.dp, vertical = 8.dp),
            shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.Bottom) {
                BasicTextField(
                    value = draft, onValueChange = change, enabled = !sending, maxLines = 4,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp).padding(horizontal = 14.dp, vertical = 12.dp)
                        .semantics { contentDescription = if (answering) "Your answer" else "Message" },
                    decorationBox = { field ->
                        Box { if (draft.isEmpty()) Text(if (answering) "Your answer" else "Message", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant); field() }
                    },
                )
                FilledIconButton(
                    onClick = send, enabled = writable && !sending && (draft.isNotBlank() || hasAttachments), modifier = Modifier.size(48.dp).semantics { contentDescription = "Send" },
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = MessageBlue, contentColor = Color.White),
                ) {
                    if (sending) CircularProgressIndicator(Modifier.size(20.dp).semantics { contentDescription = "Sending" }, strokeWidth = 2.dp)
                    else CompanionIcon(CompanionSymbol.Up)
                }
            }
        }
    }
}
