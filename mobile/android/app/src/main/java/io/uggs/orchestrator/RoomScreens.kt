package io.uggs.orchestrator

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.flow.distinctUntilChanged
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import android.text.format.DateFormat
import java.time.Instant
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

@Composable internal fun RoomRow(room: JSONObject, enabled: Boolean, open: () -> Unit) {
    Surface(onClick = open, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp).testTag("room:${room.optString("id")}")) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.secondaryContainer) {
                Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { CompanionIcon(if (room.optString("kind") == "conference") CompanionSymbol.Conference else CompanionSymbol.Group, roomLabel(room)) }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(room.optString("title"), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text("${roomLabel(room)} · ${room.optJSONArray("members")?.length() ?: 0} participants", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (room.optString("status") != "open") Text(room.optString("status").replaceFirstChar(Char::uppercaseChar), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (room.optInt("unread") > 0) Badge { Text(room.optInt("unread").toString()) }
        }
    }
}

@Composable internal fun RoomScreen(model: CompanionModel, fresh: Boolean) {
    val state = model.roomChats
    val id = state.selected ?: return
    val room = state.current
    val scroll = rememberLazyListState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var positioned by rememberSaveable(id) { mutableStateOf(false) }
    var details by rememberSaveable(id) { mutableStateOf(false) }
    var recipientMenu by remember { mutableStateOf(false) }
    val uploads = model.chatUploads["room:$id"] ?: emptyList()
    val writable = fresh && model.can("agent_messaging.manage") && model.can("agent_messaging.reveal_content") && room?.optString("status") == "open"
    val last = state.events.lastOrNull()
    LaunchedEffect(id, state.events.size) {
        if (!positioned && state.events.isNotEmpty()) {
            scroll.scrollToItem(state.events.lastIndex + if (state.nextBefore != null) 1 else 0)
            positioned = true
        }
    }
    LaunchedEffect(id, last?.optString("id"), fresh) {
        snapshotFlow {
            val visible = scroll.layoutInfo.visibleItemsInfo.any { it.key == last?.optString("id") }
            fresh && visible && !scroll.canScrollForward && !scroll.isScrollInProgress && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        }.distinctUntilChanged().collect { visible -> if (visible && last != null && state.selected == id) state.seen(last.optString("created_at")) }
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(room?.let { "${roomLabel(it)} · ${it.optJSONArray("members")?.length() ?: 0} participants" }.orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = { details = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Details") }
        }
        room?.optJSONArray("members")?.objects()?.takeIf { it.isNotEmpty() }?.let { members ->
            val agents = model.agents.takeIf { model.overviewAvailable() }
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp).testTag("room-members"), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                members.forEach { member ->
                    val presence = roomMemberPresence(member, agents)
                    Column(Modifier.widthIn(min = 56.dp, max = 88.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        MemberAvatar(member, presence)
                        Text(roomPersonLabel(member), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(roomPresenceLabel(presence), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
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
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("room-timeline"), state = scroll, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            if (state.nextBefore != null) item { TextButton(onClick = state::older, enabled = !state.loading) { Text("Earlier messages") } }
            if (state.events.isEmpty() && !state.loading && state.error == null) item {
                Column(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("A place to think together", style = MaterialTheme.typography.titleMedium)
                    Text("Share a message, or ask an agent for an answer.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            items(state.events, key = { it.getString("id") }) { event ->
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(event.optString("name"), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    val instant = runCatching { Instant.parse(event.optString("created_at")) }.getOrNull()
                    Text(instant?.let { "${dayLabel(it.atZone(java.time.ZoneId.systemDefault()).toLocalDate())} · ${timeLabel(it, DateFormat.is24HourFormat(LocalContext.current))}" } ?: event.optString("created_at"), Modifier.semantics { contentDescription = event.optString("created_at") }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    ChatMarkdown(event.optString("content"))
                    event.optJSONArray("attachments")?.strings()?.forEach { ChatAttachment(model, "room:$id", it) }
                    event.optJSONArray("deliveries")?.objects()?.forEach { delivery ->
                        val member = room?.optJSONArray("members")?.objects()?.find { it.optString("id") == delivery.optString("address_id") }
                        Text("${member?.optString("name") ?: "Agent"}: ${delivery.optString("status").replace('_', ' ')}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        Surface(tonalElevation = 1.dp) {
            Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!writable) Text(if (!fresh) "Reconnect to send. Your draft stays here." else "This conversation is read-only.", style = MaterialTheme.typography.bodySmall)
                Box {
                    TextButton(onClick = { recipientMenu = true }, enabled = writable && state.pendingSend == null) {
                        Text(when (state.target) { "" -> "Share with the room"; "all" -> "Ask the room"; else -> "Ask ${room?.optJSONArray("members")?.objects()?.find { it.optString("id") == state.target }?.optString("name") ?: "agent"}" })
                    }
                    DropdownMenu(expanded = recipientMenu, onDismissRequest = { recipientMenu = false }) {
                        DropdownMenuItem(text = { Text("Share without requesting an answer") }, onClick = { state.target = ""; recipientMenu = false })
                        DropdownMenuItem(text = { Text("Ask the room") }, onClick = { state.target = "all"; recipientMenu = false })
                        room?.optJSONArray("members")?.objects()?.forEach { member ->
                            DropdownMenuItem(text = { Text(member.optString("name")) }, enabled = member.optBoolean("reachable") && member.optBoolean("chat_capable"), onClick = { state.target = member.getString("id"); recipientMenu = false })
                        }
                    }
                }
                ChatUploadControls(model, "room:$id", writable && !state.busy && state.pendingSend == null) { attach, camera ->
                    OutlinedTextField(value = state.draft, onValueChange = { state.draft = it }, label = { Text("Message the room") }, modifier = Modifier.fillMaxWidth().testTag("room-composer"), minLines = 2, maxLines = 6, readOnly = state.pendingSend != null)
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = attach, enabled = writable && state.pendingSend == null) { CompanionIcon(CompanionSymbol.Attach, "Attach files") }
                        IconButton(onClick = camera, enabled = writable && state.pendingSend == null) { CompanionIcon(CompanionSymbol.Camera, "Take photo") }
                        Spacer(Modifier.weight(1f))
                        Button(onClick = { state.send(uploads.map { it.id }, model::roomSent) }, enabled = writable && !state.busy && uploads.all { it.state == "ready" } && (state.draft.isNotBlank() || uploads.isNotEmpty() || state.pendingSend != null), modifier = Modifier.heightIn(min = 48.dp).testTag("room-send")) {
                            Text(if (state.busy) "Sending…" else if (state.pendingSend != null) "Retry send" else "Send")
                        }
                    }
                }
            }
        }
    }
    if (details && room != null) RoomDetails(model, room, writable) { details = false }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun NewRoomSheet(model: CompanionModel, dismiss: () -> Unit) {
    val state = model.roomChats
    val pending = state.pendingOperation?.takeIf { it.optString("_path") == "/rooms/create" }
    var kind by rememberSaveable { mutableStateOf(pending?.optString("kind") ?: "group") }
    var title by rememberSaveable { mutableStateOf(pending?.optString("title").orEmpty()) }
    var description by rememberSaveable { mutableStateOf(pending?.optString("description").orEmpty()) }
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
            Text(if (kind == "conference") "A focused discussion with a one-hour deadline." else "A shared place for ongoing work.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                if (title.isNotBlank()) state.operate("/rooms/create", JSONObject().put("kind", kind).put("title", title).put("description", description).put("members", JSONArray(members.toList()))) { result ->
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
    ModalBottomSheet(onDismissRequest = dismiss, shape = SheetShape, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(room.optString("title"), style = MaterialTheme.typography.titleLarge)
            if (room.optString("description").isNotBlank()) Text(room.optString("description"))
            Text("Participants", style = MaterialTheme.typography.titleMedium)
            room.optJSONArray("members")?.objects()?.forEach { member ->
                val presence = roomMemberPresence(member, model.agents.takeIf { model.overviewAvailable() })
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    MemberAvatar(member, presence)
                    Column(Modifier.weight(1f)) {
                        Text(member.optString("name"))
                        Text(if (!member.optBoolean("chat_capable")) "Update cxx to answer here" else roomPresenceLabel(presence), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (writable && room.optString("kind") in setOf("group", "conference")) IconButton(onClick = { remove = member }, enabled = !state.busy) { CompanionIcon(CompanionSymbol.Close, "Remove ${member.optString("name")}") }
                }
            }
            if (writable && room.optString("kind") in setOf("group", "conference")) {
                TextButton(onClick = { invite = !invite; if (invite) state.loadCandidates() }) { Text("Add participant") }
                if (invite) state.candidates.filter { candidate -> room.optJSONArray("members")?.objects()?.none { it.optString("id") == candidate.optString("id") } != false }.forEach { candidate ->
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
