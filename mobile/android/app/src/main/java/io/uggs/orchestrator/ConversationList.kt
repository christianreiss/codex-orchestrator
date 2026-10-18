package io.uggs.orchestrator

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.time.Instant

@Composable internal fun NowScreen(model: CompanionModel, agents: List<JSONObject>, fresh: Boolean, now: Long = System.currentTimeMillis()) {
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf("chats") }
    var createRoom by rememberSaveable { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    val search = query.trim()
    fun attention(agent: JSONObject) = fresh && model.can("agent_portal.manage") && needsReply(agent) && (hasUrgentNotice(agent) || isReachable(agent))
    // Filter only the already-authorized overview. Searching never fetches a
    // transcript or changes a read marker.
    val activeAgents = if (model.roomChats.history) emptyList() else agents.filter(::isOnlineActiveAgent)
    val rooms = model.roomChats.rooms.filter { model.roomChats.history || roomHasActiveAgent(it) }
    val categories = buildList {
        if (activeAgents.isNotEmpty()) add("chats" to "Chats")
        if (rooms.any { it.optString("kind") != "conference" }) add("group" to "Groups")
        if (rooms.any { it.optString("kind") == "conference" }) add("conference" to "Conferences")
    }
    val selected = filter.takeIf { id -> categories.any { it.first == id } } ?: categories.firstOrNull()?.first
    LaunchedEffect(selected) { selected?.let { filter = it } }
    val visible = if (selected != "chats") emptyList() else activeAgents.filter { agent ->
        search.isEmpty() || listOf(agentTitle(agent), agent.optString("cwd"),
            agentHost(agent).orEmpty(), agentSummary(agent).orEmpty(), agent.optString("engine"))
            .any { it.contains(search, ignoreCase = true) }
    }
    val shared = rooms.filter { room ->
        (selected == "conference" && room.optString("kind") == "conference" ||
            selected == "group" && room.optString("kind") != "conference") &&
            (search.isBlank() || room.optString("title").contains(search, true) || room.optString("description").contains(search, true))
    }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 4.dp, bottom = 4.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(if (model.roomChats.history) "Conference history" else "Conversations", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                if (model.can("agent_messaging.read") && model.roomChats.supported && model.roomChats.enabled)
                    TextButton(onClick = { model.roomChats.showHistory(!model.roomChats.history); model.refreshNow() }, enabled = fresh, modifier = Modifier.testTag("conference-history-toggle")) { Text(if (model.roomChats.history) "Active" else "History") }
                if (model.can("agent_messaging.manage") && model.can("agent_messaging.reveal_content") && model.roomChats.supported && model.roomChats.enabled)
                    TextButton(onClick = { createRoom = true; model.roomChats.loadCandidates() }, enabled = fresh) { Text("New") }
            }
            OutlinedTextField(
                value = query, onValueChange = { query = it }, singleLine = true,
                modifier = Modifier.fillMaxWidth().testTag("chat-search").semantics { contentDescription = "Search chats" },
                placeholder = { Text("Search chats") },
                leadingIcon = { CompanionIcon(CompanionSymbol.Search, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
                trailingIcon = if (query.isNotEmpty()) { {
                    IconButton(onClick = { query = "" }, modifier = Modifier.size(48.dp)) { CompanionIcon(CompanionSymbol.Close, "Clear search") }
                } } else null,
                shape = MaterialTheme.shapes.medium,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    focusedBorderColor = MaterialTheme.colorScheme.primary, unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                ),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
            )
            if (categories.isNotEmpty()) Row(
                Modifier.fillMaxWidth().padding(top = 10.dp).selectableGroup()
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(10.dp)).padding(3.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                categories.forEach { (id, label) ->
                    val active = selected == id
                    Surface(
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                            .testTag("chat-filter:$id")
                            .selectable(selected = active, role = Role.Tab, onClick = { filter = id }),
                        shape = RoundedCornerShape(8.dp),
                        color = if (active) MaterialTheme.colorScheme.surface else Color.Transparent,
                        shadowElevation = if (active) 1.dp else 0.dp,
                    ) {
                        Box(Modifier.padding(horizontal = 4.dp, vertical = 10.dp), contentAlignment = Alignment.Center) {
                            Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
                                color = if (active) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                        }
                    }
                }
            }
        }
        LazyColumn(Modifier.fillMaxSize().testTag("chat-list"), contentPadding = PaddingValues(bottom = 96.dp)) {
            if (!model.roomChats.supported || !model.roomChats.enabled) item(key = "rooms-unavailable") {
                Text(if (!model.roomChats.supported) "Shared conversations require a server update." else "Shared conversations are disabled on this server.", Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!fresh && !model.connecting) item(key = "reconnect") {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Text("Checking what needs you…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = model::refreshNow, modifier = Modifier.heightIn(min = 48.dp)) { Text("Retry connection") }
                }
            }
            itemsIndexed(visible, key = { _, agent -> "agent:" + agent.getString("id") }) { index, agent ->
                AgentRow(agent, now, attention(agent), model.unreadReplyCount(agent.getString("id")), index < visible.lastIndex) { model.openSession(agent.getString("id")) }
            }
            itemsIndexed(shared, key = { _, room -> "room:" + room.getString("id") }) { _, room ->
                RoomRow(room, model.can("agent_messaging.reveal_content")) { model.openRoom(room) }
            }
            if (model.roomChats.nextOffset != null) item { TextButton(onClick = model.roomChats::more, enabled = fresh && !model.roomChats.loading) { Text("More conversations") } }
            if (visible.isEmpty() && shared.isEmpty()) item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val empty = when {
                        model.connecting -> "Loading your chats…"
                        search.isNotEmpty() -> "No chats found"
                        fresh && model.roomChats.history -> "No closed conferences"
                        fresh -> "All caught up"
                        else -> "Waiting for chats"
                    }
                    if (model.connecting) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                    Text(empty, style = MaterialTheme.typography.titleMedium)
                    if (!model.connecting && search.isNotEmpty()) TextButton(onClick = { query = "" }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Clear search") }
                    else if (fresh && !model.roomChats.history) Text("No active agents online.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
    if (createRoom) NewRoomSheet(model) { createRoom = false }
}

@Composable private fun AgentRow(agent: JSONObject, now: Long, attention: Boolean, unreadCount: Int, divider: Boolean, onClick: () -> Unit) {
    val important = hasUrgentNotice(agent)
    val badgeColor = if (important) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    val badgeContentColor = if (important) MaterialTheme.colorScheme.onError else MaterialTheme.colorScheme.onPrimary
    val timestamp = runCatching { Instant.parse(agent.optJSONObject("preview")?.optString("created_at").orEmpty().ifBlank { agent.optString("last_event_at") }) }.getOrNull()
    val host = agentHost(agent)
    val shortHost = host?.let { if (it.contains(':') || it.all { char -> char.isDigit() || char == '.' }) it else it.substringBefore('.') }
    val directory = agent.optString("cwd").trim().takeIf(String::isNotBlank)
    val summary = agentSummary(agent)
    Surface(onClick = onClick, modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp).testTag("agent:" + agent.optString("id")).semantics {
        stateDescription = when (unreadCount) { 0 -> "Read"; 1 -> "1 unread reply"; else -> "$unreadCount unread replies" }
    }, shape = RectangleShape, color = MaterialTheme.colorScheme.background) {
        Column {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                AgentAvatar(agent)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(agentTitle(agent), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold,
                        maxLines = if (LocalDensity.current.fontScale > 1.1f) 2 else 1, overflow = TextOverflow.Ellipsis)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (host != null) {
                            Text(shortHost.orEmpty(), modifier = Modifier.widthIn(max = 104.dp).clearAndSetSemantics { contentDescription = "Host: $host" },
                                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (directory != null) Text(" · ", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.outline)
                        }
                        if (directory != null) Text(directory, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Text(activityDetail(agent, now), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (summary != null) Text(summary, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (agent.optBoolean("daemon_session") && summary == null) Text(remoteStatus(agent.optString("remote_status")), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (attention || important) Text(agent.optJSONObject("attention")?.optString("severity")?.takeIf { it.isNotBlank() } ?: if (important) "Important" else "Reply needed", style = MaterialTheme.typography.labelSmall, color = badgeColor)
                }
                Column(Modifier.align(Alignment.Top).padding(top = 2.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(Modifier.heightIn(min = 18.dp)) {
                        timestamp?.let { Text(timeLabel(it, DateFormat.is24HourFormat(LocalContext.current)), style = MaterialTheme.typography.labelSmall,
                            color = if (unreadCount > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
                    }
                    if (unreadCount > 0) Surface(Modifier.testTag("unread-badge:" + agent.optString("id")).semantics {
                        contentDescription = if (important) "Important unread replies" else "Unread replies"
                    }.defaultMinSize(minWidth = 24.dp, minHeight = 24.dp), shape = CircleShape, color = badgeColor) {
                        Box(Modifier.padding(horizontal = 6.dp, vertical = 3.dp), contentAlignment = Alignment.Center) {
                            Text(if (unreadCount > 99) "99+" else unreadCount.toString(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = badgeContentColor)
                        }
                    }
                }
            }
            if (divider) HorizontalDivider(Modifier.padding(start = 80.dp, end = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))
        }
    }
}
