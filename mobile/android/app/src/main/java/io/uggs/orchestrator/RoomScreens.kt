package io.uggs.orchestrator

import android.content.ClipData
import android.text.format.DateFormat
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import kotlin.math.roundToInt

private fun roomSymbol(room: JSONObject) = when (room.optString("kind")) {
    "conference" -> CompanionSymbol.Conference
    "project" -> CompanionSymbol.Terminal
    "host" -> CompanionSymbol.Computer
    else -> CompanionSymbol.Group
}

/** Seconds-accurate enough clock for conference countdowns. */
@Composable private fun rememberMinuteClock(): Instant {
    val now by produceState(Instant.now()) { while (true) { delay(30_000); value = Instant.now() } }
    return now
}

@Composable private fun deadlineText(room: JSONObject, now: Instant): String? {
    if (room.optString("kind") != "conference" || room.optString("status") != "open") return null
    val minutes = minutesUntil(room.optString("deadline_at").takeIf { it.isNotBlank() && it != "null" }, now) ?: return null
    return if (minutes <= 0) stringResource(R.string.room_deadline_reached) else stringResource(R.string.room_ends_in, remainingLabel(minutes))
}

/** Room rows read like agent rows: what was said last, when, and how much is unread. */
@Composable internal fun RoomRow(room: JSONObject, enabled: Boolean, now: Instant, preview: JSONObject? = null, divider: Boolean = false, open: () -> Unit) {
    val unread = room.optInt("unread")
    val members = room.optJSONArray("members")?.objects().orEmpty()
    val time = runCatching { Instant.parse(room.optString("last_activity_at").ifBlank { room.optString("created_at") }) }.getOrNull()
    val use24 = DateFormat.is24HourFormat(LocalContext.current)
    val names = members.map(::roomPersonLabel)
    val previewText = preview?.let { event -> compactSummary(event.optString("content"))?.let { stringResource(R.string.room_preview, roomPersonLabel(event), it) } }
        ?: if (names.isEmpty()) stringResource(R.string.room_no_participants) else names.take(3).joinToString(", ") + if (names.size > 3) " +${names.size - 3}" else ""
    val deadline = deadlineText(room, now)
    Surface(onClick = open, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp).testTag("room:${room.optString("id")}").semantics {
        stateDescription = when (unread) { 0 -> "Read"; 1 -> "1 unread message"; else -> "$unread unread messages" }
    }, shape = RectangleShape, color = MaterialTheme.colorScheme.background) {
        Column {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Surface(Modifier.size(52.dp), shape = CircleShape, color = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer) {
                    Box(contentAlignment = Alignment.Center) { CompanionIcon(roomSymbol(room), roomLabel(room)) }
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(room.optString("title"), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(roomLabel(room), "${members.size} participants",
                        room.optString("status").takeIf { it != "open" && it.isNotBlank() }?.replaceFirstChar(Char::uppercaseChar), deadline).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(previewText, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Column(Modifier.align(Alignment.Top).padding(top = 2.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    time?.let { Text(listTimeLabel(it, now, use24), style = MaterialTheme.typography.labelSmall,
                        color = if (unread > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
                    if (unread > 0) Surface(Modifier.defaultMinSize(minWidth = 24.dp, minHeight = 24.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primary) {
                        Box(Modifier.padding(horizontal = 6.dp, vertical = 3.dp), contentAlignment = Alignment.Center) {
                            Text(if (unread > 99) "99+" else unread.toString(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimary)
                        }
                    }
                }
            }
            if (divider) HorizontalDivider(Modifier.padding(start = 80.dp, end = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))
        }
    }
}

private fun roomQuote(messages: List<ChatMessage>, id: String, unavailable: String): ReplyPreview {
    val target = messages.firstOrNull { (it.key as? MessageKey.RoomEvent)?.id == id } ?: return ReplyPreview(unavailable, "")
    val text = target.text.trim()
    return ReplyPreview(target.author.name ?: "Agent", text.ifBlank { if (target.attachments.size == 1) "Attachment" else if (target.attachments.size > 1) "${target.attachments.size} attachments" else "Message" })
}

@Composable internal fun RoomScreen(model: CompanionModel, fresh: Boolean) {
    val state = model.roomChats
    val id = state.selected ?: return
    val room = state.current
    val members = room?.optJSONArray("members")?.objects().orEmpty()
    val agents = model.agents.takeIf { model.overviewAvailable() }
    val presences = members.associate { it.optString("id") to roomMemberPresence(it, agents) }
    val initials = state.initials(id, members)
    val scroll = rememberLazyListState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    var positioned by rememberSaveable(id) { mutableStateOf(false) }
    var details by rememberSaveable(id) { mutableStateOf(false) }
    val uploads = model.chatUploads["room:$id"] ?: emptyList()
    val writable = fresh && model.can("agent_messaging.manage") && model.can("agent_messaging.reveal_content") && room?.optString("status") == "open"
    val last = state.events.lastOrNull()
    val readMarkers = remember(state.events, room) { roomReadMarkers(state.events, members) }
    val messages = remember(state.events) { state.events.map { ChatMessage.fromRoomEvent(it) } }
    // Unconfirmed sends follow the confirmed events as local bubbles; they never join state.events.
    val outgoing = state.outgoing
    val sendStates = outgoing.map(state::sendStatus)
    val local = remember(outgoing, sendStates) { state.localEvents }
    val items = remember(state.events, local) { buildTimeline(roomTimelineEntries(state.events) + roomTimelineEntries(local)) }
    val currentItems by rememberUpdatedState(items)
    val working = if (fresh) members.filter { presences[it.optString("id")] == "working" } else emptyList()
    val header = if (state.nextBefore != null) 1 else 0
    val empty = state.events.isEmpty() && local.isEmpty() && !state.loading && state.error == null
    val endIndex = header + (if (empty) 1 else 0) + items.size + (if (working.isNotEmpty()) 1 else 0)
    // Following drops only when the reader moves the list, never during our own scrolls,
    // so an arriving message does not flash "New messages" while the follow animation runs.
    var following by remember(id) { mutableStateOf(true) }
    var autoScrolling by remember { mutableStateOf(false) }
    suspend fun autoScroll(index: Int, animate: Boolean = true) {
        autoScrolling = true
        try { if (animate) scroll.animateScrollToItem(index) else scroll.scrollToItem(index) } finally { autoScrolling = false }
    }
    var anchorKey by remember(id) { mutableStateOf<String?>(null) }
    var expandedRuns by remember(id) { mutableStateOf(emptySet<String>()) }
    var highlight by remember { mutableStateOf<String?>(null) }
    var transient by remember { mutableStateOf<String?>(null) }
    val notLoaded = stringResource(R.string.chat_quote_not_loaded)
    val unavailable = stringResource(R.string.chat_quote_unavailable)
    val now = rememberMinuteClock()
    LaunchedEffect(highlight) { if (highlight != null) { delay(1600); highlight = null } }
    LaunchedEffect(transient) { if (transient != null) { delay(2500); transient = null } }
    LaunchedEffect(id, state.events.size) {
        if (!positioned && state.events.isNotEmpty()) {
            autoScroll(endIndex, animate = false)
            positioned = true
        }
    }
    LaunchedEffect(scroll, id) {
        var previous: Pair<Int, Int>? = null
        var previousHeight: Int? = null
        snapshotFlow { scroll.layoutInfo }.collect { layout ->
            val last = layout.visibleItemsInfo.lastOrNull()
            val end = last == null || (last.index == layout.totalItemsCount - 1 && last.offset + last.size <= layout.viewportEndOffset)
            val position = layout.visibleItemsInfo.firstOrNull()?.let { it.index to it.offset }
            val resized = previousHeight != layout.viewportSize.height
            val moved = previous != null && position != previous
            previous = position; previousHeight = layout.viewportSize.height
            if (end) { following = true; anchorKey = currentItems.lastOrNull()?.key }
            else if (resized && following) scroll.requestScrollToItem(layout.totalItemsCount - 1)
            else if (!resized && moved && !autoScrolling) following = false
        }
    }
    // Follow new messages while the reader is at the end; otherwise offer the "New messages" jump.
    LaunchedEffect(items.lastOrNull()?.key, working.size) { if (positioned && following) autoScroll(endIndex) }
    LaunchedEffect(id, last?.optString("id"), fresh) {
        snapshotFlow {
            val visible = scroll.layoutInfo.visibleItemsInfo.any { it.key == last?.optString("id")?.let { event -> "event:$event" } }
            fresh && visible && !scroll.canScrollForward && !scroll.isScrollInProgress && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        }.distinctUntilChanged().collect { visible -> if (visible && last != null && state.selected == id) state.seen(last.optString("created_at")) }
    }
    fun jumpTo(eventId: String) {
        val index = items.indexOfFirst { it.key == "event:$eventId" }
        if (index < 0) transient = notLoaded
        else scope.launch { autoScroll(header + index); highlight = "event:$eventId" }
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(room?.let { listOfNotNull("${roomLabel(it)} · ${members.size} participants", deadlineText(it, now)).joinToString(" · ") }.orEmpty(),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                room?.optString("description")?.takeIf { it.isNotBlank() && it != "null" }?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            TextButton(onClick = { details = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Details") }
        }
        if (members.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp).testTag("room-members"), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            members.forEach { member ->
                val presence = presences.getValue(member.optString("id"))
                Column(Modifier.widthIn(min = 56.dp, max = 88.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    RoomMemberAvatar(member, initials, presence, memberCount = members.size)
                    Text(roomPersonLabel(member), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(roomPresenceLabel(presence), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
            }
        }
        HorizontalDivider()
        state.error?.let { message ->
            Surface(color = MaterialTheme.colorScheme.errorContainer) {
                Column(Modifier.fillMaxWidth().padding(16.dp)) {
                    Text(message)
                    if (state.pendingSend == null) TextButton(onClick = state::retryRead) { Text("Retry") }
                }
            }
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(Modifier.fillMaxSize().testTag("room-timeline"), state = scroll, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 12.dp)) {
                if (state.nextBefore != null) item(key = "earlier") { TextButton(onClick = state::older, enabled = !state.loading) { Text("Earlier messages") } }
                if (empty) item(key = "empty") {
                    Column(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("A place to think together", style = MaterialTheme.typography.titleMedium)
                        Text("Share a message, or ask an agent for an answer.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                timelineItems(items, expandedRuns, { key -> expandedRuns = if (key in expandedRuns) expandedRuns - key else expandedRuns + key },
                    after = { item -> item.key.removePrefix("event:").let { readMarkers[it] }?.let { ReadByRow(it, initials, members.size) } }) { item ->
                    RoomBubble(model, id, item, messages, members, initials, presences, writable && state.pendingSend == null, highlight == item.key, unavailable, ::jumpTo)
                }
                if (working.isNotEmpty()) item(key = "typing") {
                    val names = working.joinToString(", ", transform = ::roomPersonLabel)
                    TypingIndicator(stringResource(R.string.chat_agent_working, names)) { RoomMemberAvatar(working.first(), initials, null, 28.dp, members.size) }
                }
                item(key = "end") { Spacer(Modifier.height(1.dp)) }
            }
            transient?.let { message ->
                Surface(Modifier.align(Alignment.TopCenter).padding(top = 8.dp), shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.inverseSurface, contentColor = MaterialTheme.colorScheme.inverseOnSurface) {
                    Text(message, Modifier.padding(horizontal = 14.dp, vertical = 10.dp), style = MaterialTheme.typography.bodyMedium)
                }
            }
            val unseen = if (!following && positioned) unseenSince(items, anchorKey) else null
            if (unseen != null) NewMessagesPill(unseen.count, onClick = {
                anchorKey = items.lastOrNull()?.key
                scope.launch { autoScroll(header + unseen.firstIndex) }
            }, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp))
        }
        Surface(tonalElevation = 1.dp) {
            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (!writable) Text(if (!fresh) "Reconnect to send. Your draft stays here." else "This conversation is read-only.", Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall)
                state.replyTo?.let { target ->
                    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        ReplyQuote(roomQuote(messages, target, unavailable), Modifier.weight(1f), onClick = { jumpTo(target) })
                        IconButton(onClick = { state.replyTo = null }) { CompanionIcon(CompanionSymbol.Close, "Cancel reply") }
                    }
                }
                RecipientChips(state.recipients, members, writable && state.pendingSend == null) { state.recipients = it }
                ChatUploadControls(model, "room:$id", writable && !state.busy && state.pendingSend == null) { attach, camera ->
                    // An unconfirmed send is retried before anything new goes out, keeping the room's order.
                    ChatComposer(state.draft, { state.draft = it }, "Message the room",
                        canSend = writable && !state.busy && uploads.all { it.state == "ready" } && (state.draft.isNotBlank() || uploads.isNotEmpty() || state.pendingSend != null),
                        sending = state.busy, fieldEnabled = true,
                        fieldTag = "room-composer", sendTag = "room-send",
                        sendLabel = if (state.busy) "Sending…" else if (state.pendingSend != null) "Retry send" else "Send",
                        mediaActions = {
                            IconButton(onClick = attach, enabled = writable && state.pendingSend == null) { CompanionIcon(CompanionSymbol.Attach, "Attach files") }
                            if (state.draft.isEmpty()) IconButton(onClick = camera, enabled = writable && state.pendingSend == null) { CompanionIcon(CompanionSymbol.Camera, "Take photo") }
                        }) { state.send(uploads.map { it.id }, model::roomSent) }
                }
            }
        }
    }
    if (details && room != null) RoomDetails(model, room, writable) { details = false }
}

@Composable private fun RoomBubble(
    model: CompanionModel, roomId: String, item: TimelineItem.Bubble, messages: List<ChatMessage>, members: List<JSONObject>,
    initials: Map<String, String>, presences: Map<String, String>, replyable: Boolean, highlighted: Boolean, unavailable: String, jumpTo: (String) -> Unit,
) {
    val message = item.message
    val colors = bubbleColors(item.own, null)
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var selecting by remember(item.key) { mutableStateOf(false) }
    val copyLabel = stringResource(R.string.chat_copy)
    val selectLabel = stringResource(R.string.chat_select_text)
    val eventId = (message.key as? MessageKey.RoomEvent)?.id
    val localStatus = message.localStatus
    val reply = if (replyable && eventId != null && localStatus == null) ({ model.roomChats.replyTo = eventId }) else null
    val actions = buildList {
        if (reply != null) add(BubbleAction("Reply", CompanionSymbol.Reply, reply))
        if (message.text.isNotBlank()) {
            add(BubbleAction(copyLabel) { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(copyLabel, message.text))) } })
            add(BubbleAction(selectLabel) { selecting = true })
        }
    }
    val member = members.firstOrNull { "agent:" + it.optString("id") == message.author.id }
    val name = message.author.name ?: member?.let(::roomPersonLabel) ?: "Agent"
    val avatar: (@Composable () -> Unit)? = if (item.own) null else {
        {
            if (member != null) RoomMemberAvatar(member, initials, presences[member.optString("id")], 30.dp, members.size)
            else {
                val stranger = JSONObject().put("id", message.author.id ?: name).put("name", name)
                GroupAvatar(stranger, memberInitials(mapOf("x" to name)).getValue("x"), null, 30.dp, engineBadge = false)
            }
        }
    }
    ChatBubble(item, "room-message:${eventId.orEmpty()}", colors, actions, reply, highlighted, author = name, avatar = avatar) {
        (message.replyTo as? MessageKey.RoomEvent)?.let { target ->
            ReplyQuote(roomQuote(messages, target.id, unavailable), accent = if (item.own) colors.content else MaterialTheme.colorScheme.primary, onClick = { jumpTo(target.id) })
        }
        message.attachments.forEach { ChatAttachment(model, "room:$roomId", it) }
        if (message.text.isNotBlank()) BubbleText(message.text, markdown = !item.own, colors, selecting) { selecting = false }
        roomDeliverySummary(message, messages)?.let { DeliveryPills(it, members, colors) }
        if (localStatus != null && eventId != null) LocalSendActions(model, eventId, localStatus, colors)
        BubbleFooter(item, colors) {
            if (localStatus != null) Text(stringResource(when (localStatus) {
                "sending" -> R.string.chat_send_sending
                "failed" -> R.string.chat_send_failed
                else -> R.string.chat_send_unconfirmed
            }), Modifier.testTag("room-send-status:$eventId"), style = MaterialTheme.typography.labelSmall, color = colors.secondary)
        }
    }
}

/** Retry for an unconfirmed or failed local room send; a definitive failure can also be discarded. */
@Composable private fun LocalSendActions(model: CompanionModel, entryId: String, status: String, colors: BubbleColors) {
    if (status == "sending") return
    val state = model.roomChats
    val writable = model.fresh() && model.can("agent_messaging.manage") && model.can("agent_messaging.reveal_content")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        if (status == "failed") TextButton(onClick = { state.discard(entryId) }, enabled = !state.busy,
            modifier = Modifier.heightIn(min = 48.dp).testTag("room-discard:$entryId")) { Text(stringResource(R.string.chat_discard_send), color = colors.content) }
        TextButton(onClick = { state.retry(entryId, model::roomSent) }, enabled = writable && !state.busy,
            modifier = Modifier.heightIn(min = 48.dp).testTag("room-retry:$entryId")) { Text(stringResource(R.string.chat_send_retry), color = colors.content) }
    }
}

/** "Asked 2 · 1 answered" as pills; tapping lists who is still pending. Text always states the state. */
@OptIn(ExperimentalLayoutApi::class)
@Composable private fun DeliveryPills(summary: RoomDeliverySummary, members: List<JSONObject>, colors: BubbleColors) {
    var open by remember { mutableStateOf(false) }
    val former = stringResource(R.string.room_former_member)
    val state = stringResource(if (open) R.string.chat_expanded else R.string.chat_collapsed)
    Column(Modifier.padding(horizontal = 6.dp)) {
        FlowRow(
            Modifier.heightIn(min = 48.dp).clickable(role = Role.Button) { open = !open }.semantics { stateDescription = state }.padding(vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            DeliveryPill(stringResource(R.string.room_delivery_asked, summary.asked), colors.content.copy(alpha = .14f), colors.content)
            listOf(
                RoomAnswerState.Answered to R.plurals.room_delivery_answered,
                RoomAnswerState.Waiting to R.plurals.room_delivery_waiting,
                RoomAnswerState.Unreachable to R.plurals.room_delivery_unreachable,
                RoomAnswerState.NoAnswer to R.plurals.room_delivery_no_answer,
            ).forEach { (answer, label) ->
                val count = summary.count(answer)
                if (count > 0) DeliveryPill(pluralStringResource(label, count, count), when (answer) {
                    RoomAnswerState.Answered -> Color(0xFF2E9E5B).copy(alpha = .22f)
                    RoomAnswerState.Unreachable, RoomAnswerState.NoAnswer -> MaterialTheme.colorScheme.error.copy(alpha = .18f)
                    RoomAnswerState.Waiting -> colors.content.copy(alpha = .10f)
                }, colors.content)
            }
        }
        if (open) summary.states.forEach { (target, answer) ->
            val name = members.firstOrNull { it.optString("id") == target }?.let(::roomPersonLabel) ?: former
            Text("$name · " + stringResource(when (answer) {
                RoomAnswerState.Answered -> R.string.room_answer_answered
                RoomAnswerState.Waiting -> R.string.room_answer_waiting
                RoomAnswerState.Unreachable -> R.string.room_answer_unreachable
                RoomAnswerState.NoAnswer -> R.string.room_answer_no_answer
            }), style = MaterialTheme.typography.bodySmall, color = colors.secondary)
        }
    }
}

@Composable private fun DeliveryPill(label: String, container: Color, content: Color) {
    Surface(shape = RoundedCornerShape(50), color = container, contentColor = content) {
        Text(label, Modifier.padding(horizontal = 10.dp, vertical = 4.dp), style = MaterialTheme.typography.labelMedium)
    }
}

/** Share / Ask room / @member chips; several members can be asked at once. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun RecipientChips(recipients: RoomRecipients, members: List<JSONObject>, enabled: Boolean, change: (RoomRecipients) -> Unit) {
    val chosen = (recipients as? RoomRecipients.Members)?.ids.orEmpty()
    val label = stringResource(R.string.room_recipients)
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp).semantics { contentDescription = label },
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            FilterChip(selected = recipients == RoomRecipients.Share, onClick = { change(RoomRecipients.Share) }, enabled = enabled,
                label = { Text(stringResource(R.string.room_recipient_share)) })
            FilterChip(selected = recipients == RoomRecipients.AskAll, onClick = { change(RoomRecipients.AskAll) }, enabled = enabled,
                label = { Text(stringResource(R.string.room_recipient_ask_all)) })
            members.forEach { member ->
                val id = member.optString("id")
                val askable = member.optBoolean("reachable") && member.optBoolean("chat_capable")
                val name = roomPersonLabel(member)
                val unavailable = stringResource(R.string.room_recipient_unavailable, name)
                FilterChip(selected = id in chosen, onClick = { change(recipients.toggle(id)) }, enabled = enabled && askable,
                    label = { Text("@$name", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    modifier = if (askable) Modifier else Modifier.semantics { stateDescription = unavailable })
            }
        }
        val names = members.filter { it.optString("id") in chosen }.map(::roomPersonLabel)
        Text(when (recipients) {
            RoomRecipients.Share -> stringResource(R.string.room_recipient_hint_share)
            RoomRecipients.AskAll -> stringResource(R.string.room_recipient_hint_ask_all)
            is RoomRecipients.Members -> stringResource(R.string.room_recipient_hint_members, names.joinToString(", "))
        }, Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun NewRoomSheet(model: CompanionModel, dismiss: () -> Unit) {
    val state = model.roomChats
    val pending = state.pendingOperation?.takeIf { it.optString("_path") == "/rooms/create" }
    var kind by rememberSaveable { mutableStateOf(pending?.optString("kind") ?: "group") }
    var title by rememberSaveable { mutableStateOf(pending?.optString("title").orEmpty()) }
    var description by rememberSaveable { mutableStateOf(pending?.optString("description").orEmpty()) }
    var duration by rememberSaveable { mutableIntStateOf(pending?.optInt("duration_minutes", 60) ?: 60) }
    var members by remember { mutableStateOf<Set<String>>(emptySet()) }
    var validation by remember { mutableStateOf(false) }
    var search by rememberSaveable { mutableStateOf("") }
    var discard by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = { if (!state.busy) { if (pending == null && (title.isNotBlank() || description.isNotBlank() || members.isNotEmpty())) discard = true else dismiss() } }, shape = SheetShape, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("New conversation", style = MaterialTheme.typography.titleLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("group" to "Group", "conference" to "Conference").forEach { (value, label) -> FilterChip(selected = kind == value, onClick = { kind = value }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp), enabled = !state.busy && pending == null) }
            }
            Text(if (kind == "conference") stringResource(R.string.room_conference_hint, remainingLabel(duration.toLong())) else "A shared place for ongoing work.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (kind == "conference") {
                val durationText = stringResource(R.string.room_duration, remainingLabel(duration.toLong()))
                Text(durationText, style = MaterialTheme.typography.labelLarge)
                Slider(value = duration.toFloat(), onValueChange = { duration = ((it / 5f).roundToInt() * 5).coerceIn(5, 360) },
                    valueRange = 5f..360f, steps = 70, enabled = pending == null && !state.busy,
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = durationText })
            }
            OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Title") }, readOnly = pending != null, modifier = Modifier.fillMaxWidth(), isError = validation && title.isBlank(), supportingText = if (validation && title.isBlank()) { { Text("Enter a title") } } else null)
            OutlinedTextField(value = description, onValueChange = { description = it }, label = { Text("Description (optional)") }, readOnly = pending != null, modifier = Modifier.fillMaxWidth(), maxLines = 4)
            Text("Participants", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(value = search, onValueChange = { search = it }, label = { Text("Find an agent") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            Column(Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState())) {
            state.candidates.filter { roomPersonLabel(it).contains(search, true) }.forEach { candidate ->
                val id = candidate.optString("id")
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = id in members, enabled = pending == null, onCheckedChange = { checked -> members = if (checked) members + id else members - id }, modifier = Modifier.semantics { contentDescription = roomPersonLabel(candidate) })
                    Text(roomPersonLabel(candidate), Modifier.weight(1f))
                }
            }
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = {
                validation = true
                if (title.isNotBlank()) state.operate("/rooms/create", JSONObject().put("kind", kind).put("title", title).put("description", description).put("members", JSONArray(members.toList()))
                    .apply { if (kind == "conference") put("duration_minutes", duration) }) { result ->
                    dismiss(); model.refreshNow()
                    model.openRoom(JSONObject().put("id", result.getString("room_id")).put("title", title).put("kind", kind))
                }
            }, enabled = !state.busy && model.fresh(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (state.busy) "Creating…" else if (pending != null) "Retry creation" else "Create conversation") }
        }
    }
    if (discard) AlertDialog(onDismissRequest = { discard = false }, title = { Text("Discard this conversation draft?") }, text = { Text("The conversation has not been created yet.") }, confirmButton = { TextButton(onClick = dismiss) { Text("Discard") } }, dismissButton = { TextButton(onClick = { discard = false }) { Text("Keep editing") } })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun RoomDetails(model: CompanionModel, room: JSONObject, writable: Boolean, dismiss: () -> Unit) {
    val state = model.roomChats
    var confirm by remember { mutableStateOf(false) }
    var remove by remember { mutableStateOf<JSONObject?>(null) }
    var invite by remember { mutableStateOf(false) }
    val members = room.optJSONArray("members")?.objects().orEmpty()
    val initials = state.initials(room.optString("id"), members)
    ModalBottomSheet(onDismissRequest = dismiss, shape = SheetShape, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(room.optString("title"), style = MaterialTheme.typography.titleLarge)
            if (room.optString("description").isNotBlank()) Text(room.optString("description"))
            Text("Participants", style = MaterialTheme.typography.titleMedium)
            members.forEach { member ->
                val presence = roomMemberPresence(member, model.agents.takeIf { model.overviewAvailable() })
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    RoomMemberAvatar(member, initials, presence, memberCount = members.size)
                    Column(Modifier.weight(1f)) {
                        Text(member.optString("name"))
                        Text(if (!member.optBoolean("chat_capable")) "Update cxx to answer here" else roomPresenceLabel(presence), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (writable && room.optString("kind") in setOf("group", "conference")) IconButton(onClick = { remove = member }, enabled = !state.busy) { CompanionIcon(CompanionSymbol.Close, "Remove ${member.optString("name")}") }
                }
            }
            if (writable && room.optString("kind") in setOf("group", "conference")) {
                TextButton(onClick = { invite = !invite; if (invite) state.loadCandidates() }) { Text("Add participant") }
                if (invite) state.candidates.filter { candidate -> members.none { it.optString("id") == candidate.optString("id") } }.forEach { candidate ->
                    TextButton(enabled = !state.busy, onClick = { state.operate("/rooms/manage", JSONObject().put("room_id", room.getString("id")).put("action", "invite").put("address_id", candidate.getString("id"))) { invite = false; model.refreshNow() } }) { Text(roomPersonLabel(candidate)) }
                }
            }
            if (room.optString("kind") == "conference" && writable) {
                HorizontalDivider()
                TextButton(onClick = { confirm = true }) { Text("End conference", color = MaterialTheme.colorScheme.error) }
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
    remove?.let { member -> AlertDialog(onDismissRequest = { if (!state.busy) remove = null }, title = { Text("Remove ${member.optString("name")}?") }, text = { Text("They will no longer participate in this conversation.") }, confirmButton = {
        TextButton(enabled = !state.busy, onClick = { state.operate("/rooms/manage", JSONObject().put("room_id", room.getString("id")).put("action", "remove").put("address_id", member.getString("id"))) { remove = null; model.refreshNow() } }) { Text("Remove") }
    }, dismissButton = { TextButton(onClick = { remove = null }) { Text("Keep participant") } }) }
    if (confirm) AlertDialog(onDismissRequest = { if (!state.busy) confirm = false }, title = { Text("End this conference?") }, text = { Text("Outstanding answers finish before the room closes. Its history stays available.") }, confirmButton = {
        TextButton(modifier = Modifier.testTag("confirm-close-room"), enabled = !state.busy, onClick = { state.operate("/rooms/manage", JSONObject().put("room_id", room.getString("id")).put("action", "close")) { confirm = false; dismiss(); model.refreshNow() } }) { Text("End conference") }
    }, dismissButton = { TextButton(onClick = { confirm = false }) { Text("Keep open") } })
}

/** Small avatars plus the names, so the marker is never an icon alone. */
@Composable private fun ReadByRow(readers: List<JSONObject>, initials: Map<String, String>, memberCount: Int) {
    val names = readers.map(::roomPersonLabel)
    val label = if (names.size <= 3) names.joinToString(", ") else "${names.take(2).joinToString(", ")} +${names.size - 2}"
    Row(Modifier.fillMaxWidth().padding(top = 2.dp, end = 4.dp).testTag("room-read-by").semantics(mergeDescendants = true) { contentDescription = "Read by ${names.joinToString(", ")}" },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End)) {
        readers.take(5).forEach { reader ->
            val letters = initials[reader.optString("id")]
            if (memberCount > 1 && letters != null) GroupAvatar(reader, letters, null, 20.dp, engineBadge = false)
            else Surface(Modifier.size(20.dp), shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainer) {
                Box(contentAlignment = Alignment.Center) { EngineIcon(reader, Modifier.size(14.dp)) }
            }
        }
        Text("Read by $label", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
