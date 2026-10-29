package io.uggs.orchestrator

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.res.stringResource
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
    // Recent (offline or ended) chats stay one tap away but start collapsed, so the live list stays live.
    var showRecent by rememberSaveable { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    val search = query.trim()
    fun attention(agent: JSONObject) = fresh && model.can("agent_portal.manage") && needsReply(agent) && (hasUrgentNotice(agent) || isReachable(agent))
    // Filter only the already-authorized overview. Searching never fetches a
    // transcript or changes a read marker.
    val activeAgents = if (model.roomChats.history) emptyList() else agents.filter(::isOnlineActiveAgent)
    val recentAgents = if (model.roomChats.history) emptyList() else recentChats(agents)
    // Quiet groups and project/host rooms stay listed; a conference without an active member has nobody left to answer.
    val rooms = model.roomChats.rooms.filter { model.roomChats.history || it.optString("kind") != "conference" || roomHasActiveAgent(it, agents.takeIf { model.overviewAvailable() }) }
    val projectsLabel = stringResource(R.string.chat_filter_projects)
    val hostsLabel = stringResource(R.string.chat_filter_hosts)
    val categories = buildList {
        if (activeAgents.isNotEmpty() || recentAgents.isNotEmpty()) add("chats" to "Chats")
        if (rooms.any { roomCategory(it) == "group" }) add("group" to "Groups")
        if (rooms.any { roomCategory(it) == "conference" }) add("conference" to "Conferences")
        if (rooms.any { roomCategory(it) == "project" }) add("project" to projectsLabel)
        if (rooms.any { roomCategory(it) == "host" }) add("host" to hostsLabel)
    }
    val selected = filter.takeIf { id -> categories.any { it.first == id } } ?: categories.firstOrNull()?.first
    LaunchedEffect(selected) { selected?.let { filter = it } }
    fun matches(agent: JSONObject) = search.isEmpty() || listOf(agentTitle(agent), agent.optString("cwd"),
        agentHost(agent).orEmpty(), agentSummary(agent).orEmpty(), agent.optString("engine"))
        .any { it.contains(search, ignoreCase = true) }
    val visible = if (selected != "chats") emptyList() else activeAgents.filter(::matches)
    val recent = if (selected != "chats") emptyList() else recentAgents.filter(::matches)
    val shared = rooms.filter { room ->
        roomCategory(room) == selected &&
            (search.isBlank() || room.optString("title").contains(search, true) || room.optString("description").contains(search, true))
    }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 4.dp, bottom = 4.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                // The top app bar names the screen; only the history view needs its own heading.
                if (model.roomChats.history) Text("Conference history", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                else Spacer(Modifier.weight(1f))
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
                colors = searchFieldColors(),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
            )
            if (categories.isNotEmpty()) Row(
                Modifier.fillMaxWidth().padding(top = 10.dp)
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(10.dp))
                    .then(if (categories.size > 3) Modifier.horizontalScroll(rememberScrollState()) else Modifier)
                    .selectableGroup().padding(3.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                categories.forEach { (id, label) ->
                    val active = selected == id
                    Surface(
                        modifier = (if (categories.size > 3) Modifier.widthIn(min = 84.dp) else Modifier.weight(1f)).heightIn(min = 48.dp)
                            .testTag("chat-filter:$id")
                            .selectable(selected = active, role = Role.Tab, onClick = { filter = id }),
                        shape = RoundedCornerShape(8.dp),
                        color = if (active) MaterialTheme.colorScheme.surface else Color.Transparent,
                        shadowElevation = if (active) 1.dp else 0.dp,
                    ) {
                        Box(Modifier.padding(horizontal = if (categories.size > 3) 12.dp else 4.dp, vertical = 10.dp), contentAlignment = Alignment.Center) {
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
                AgentRow(agent, now, fresh, attention(agent), model.unreadReplyCount(agent.getString("id")), index < visible.lastIndex) { model.openSession(agent.getString("id")) }
            }
            itemsIndexed(shared, key = { _, room -> "room:" + room.getString("id") }) { index, room ->
                RoomRow(room, model.canOpenRoom(room), Instant.ofEpochMilli(now), model.roomChats.previews[room.getString("id")], index < shared.lastIndex) { model.openRoom(room) }
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
            if (recent.isNotEmpty()) {
                item(key = "recent-header") { RecentHeader(recent.size, showRecent) { showRecent = !showRecent } }
                // Distinct tags: a recent chat is not a live "agent:" row.
                if (showRecent) itemsIndexed(recent, key = { _, agent -> "recent:" + agent.getString("id") }) { index, agent ->
                    AgentRow(agent, now, fresh, false, model.unreadReplyCount(agent.getString("id")), index < recent.lastIndex, "recent:") { model.openSession(agent.getString("id")) }
                }
            }
        }
    }
    if (createRoom) NewRoomSheet(model) { createRoom = false }
}

internal fun roomCategory(room: JSONObject): String = when (room.optString("kind")) {
    "conference" -> "conference"; "project" -> "project"; "host" -> "host"; else -> "group"
}

@Composable private fun RecentHeader(count: Int, expanded: Boolean, toggle: () -> Unit) {
    val state = stringResource(if (expanded) R.string.chat_expanded else R.string.chat_collapsed)
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button, onClick = toggle).testTag("recent-toggle")
        .semantics { stateDescription = state }.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.chat_recent), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(count.toString(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        CompanionIcon(if (expanded) CompanionSymbol.Up else CompanionSymbol.Down, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
    }
}

@Composable private fun AgentRow(agent: JSONObject, now: Long, fresh: Boolean, attention: Boolean, unreadCount: Int, divider: Boolean, tagPrefix: String = "agent:", onClick: () -> Unit) {
    val important = hasUrgentNotice(agent)
    val badgeColor = if (important) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    val badgeContentColor = if (important) MaterialTheme.colorScheme.onError else MaterialTheme.colorScheme.onPrimary
    val timestamp = runCatching { Instant.parse(agent.optJSONObject("preview")?.optString("created_at").orEmpty().ifBlank { agent.optString("last_event_at") }) }.getOrNull()
    val host = agentHost(agent)
    val shortHost = host?.let { if (it.contains(':') || it.all { char -> char.isDigit() || char == '.' }) it else it.substringBefore('.') }
    val directory = agent.optString("cwd").trim().takeIf(String::isNotBlank)
    val summary = agentSummary(agent)
    Surface(onClick = onClick, modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp).testTag(tagPrefix + agent.optString("id")).semantics {
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
                    AgentStatusIndicator(agent, now, fresh)
                    if (summary != null) Text(summary, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (agent.optBoolean("daemon_session") && summary == null) Text(remoteStatus(agent.optString("remote_status")), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (attention || important) Text(agent.optJSONObject("attention")?.optString("severity")?.takeIf { it.isNotBlank() } ?: if (important) "Important" else "Reply needed", style = MaterialTheme.typography.labelSmall, color = badgeColor)
                }
                Column(Modifier.align(Alignment.Top).padding(top = 2.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(Modifier.heightIn(min = 18.dp)) {
                        timestamp?.let { Text(timeLabel(it, DateFormat.is24HourFormat(LocalContext.current)), style = MaterialTheme.typography.labelSmall,
                            color = if (unreadCount > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
                    }
                    if (unreadCount > 0) Surface(Modifier.testTag(if (tagPrefix == "agent:") "unread-badge:" + agent.optString("id") else "recent-unread-badge:" + agent.optString("id")).semantics {
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

@Composable internal fun AgentStatusIndicator(agent: JSONObject, now: Long, fresh: Boolean) {
    val status = chatAgentStatus(agent, now, fresh)
    val color = when (status) {
        ChatAgentStatus.ONLINE -> Color(0xFF2E9E5B)
        ChatAgentStatus.WORKING -> Color(0xFFD69A20)
        ChatAgentStatus.OFFLINE, ChatAgentStatus.UNKNOWN -> MaterialTheme.colorScheme.outline
    }
    val detail = when {
        !fresh -> "Reconnect to update"
        status == ChatAgentStatus.ONLINE && nativeActivity(agent, now) == "waiting" -> "Waiting for you"
        status in setOf(ChatAgentStatus.ONLINE, ChatAgentStatus.WORKING) ->
            if (isReachable(agent)) "Can receive messages" else "Receiver unavailable"
        else -> null
    }
    Row(Modifier.testTag("agent-status:" + agent.optString("id")),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(8.dp).background(color, CircleShape))
        Text(listOfNotNull(status.label, detail).joinToString(" · "),
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
