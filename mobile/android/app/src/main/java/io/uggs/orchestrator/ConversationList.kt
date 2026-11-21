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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
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

/** One row of the inbox: an agent, a room or a waiting host approval. */
private sealed interface InboxItem {
    val key: String
    val time: String
    data class Agent(val agent: JSONObject) : InboxItem {
        override val key get() = "agent:" + agent.getString("id")
        override val time: String get() = agent.optJSONObject("preview")?.optString("created_at").orEmpty().ifBlank { agent.optString("last_event_at") }
    }
    data class Room(val room: JSONObject) : InboxItem {
        override val key get() = "room:" + room.getString("id")
        override val time: String get() = room.optString("last_activity_at").ifBlank { room.optString("created_at") }
    }
    data class Approval(val request: JSONObject) : InboxItem {
        override val key get() = "approval-row:" + request.optString("id")
        override val time: String get() = request.optString("created_at")
    }
}

/**
 * The inbox: what needs the operator first, then everything that is live, agents and rooms mixed by recency.
 * Offline and ended agents are not listed; their history stays reachable through search, pushes and links.
 */
@Composable internal fun NowScreen(model: CompanionModel, agents: List<JSONObject>, fresh: Boolean, now: Long = System.currentTimeMillis(),
    approvals: List<JSONObject> = emptyList(), onReview: (JSONObject) -> Unit = {}) {
    val t = rememberTexts()
    var query by rememberSaveable { mutableStateOf("") }
    val keyboard = LocalSoftwareKeyboardController.current
    val search = query.trim()
    fun attention(agent: JSONObject) = fresh && model.can("agent_portal.manage") && (needsReply(agent) || hasUrgentNotice(agent)) && model.canSendSession(agent.optString("id"))
    val history = model.roomChats.history
    val activeAgents = if (history) emptyList() else agents.filter(::isOnlineActiveAgent)
    // Quiet groups and project/host rooms stay listed; a conference without an active member has nobody left to answer.
    val rooms = model.roomChats.rooms.filter { history || it.optString("kind") != "conference" || roomHasActiveAgent(it, agents.takeIf { model.overviewAvailable() }) }
    val searchLabel = stringResource(R.string.chat_search)
    fun matches(agent: JSONObject) = search.isEmpty() || listOf(agentTitle(t, agent), agent.optString("cwd"),
        agentHost(agent).orEmpty(), agentSummary(t, agent).orEmpty(), agent.optString("engine"))
        .any { it.contains(search, ignoreCase = true) }
    fun roomMatches(room: JSONObject) = search.isBlank() || room.optString("title").contains(search, true) || room.optString("description").contains(search, true)
    val visibleAgents = activeAgents.filter(::matches)
    val (urgent, calm) = visibleAgents.partition(::attention)
    val waitingApprovals = if (history || search.isNotEmpty()) emptyList() else approvals
    val needsYou = waitingApprovals.map { InboxItem.Approval(it) } + urgent.map { InboxItem.Agent(it) }
    val active = (calm.map { InboxItem.Agent(it) } + rooms.filter(::roomMatches).map { InboxItem.Room(it) }).sortedByDescending { it.time }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = Space.l).padding(top = Space.xs, bottom = Space.s)) {
            TextField(
                value = query, onValueChange = { query = it }, singleLine = true,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("chat-search").semantics { contentDescription = searchLabel },
                placeholder = { Text(searchLabel, style = MaterialTheme.typography.bodyLarge) },
                leadingIcon = { CompanionIcon(CompanionSymbol.Search, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
                trailingIcon = if (query.isNotEmpty()) { {
                    IconButton(onClick = { query = "" }, modifier = Modifier.size(48.dp)) { CompanionIcon(CompanionSymbol.Close, stringResource(R.string.chat_clear_search)) }
                } } else null,
                shape = CircleShape,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh, unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
                ),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
            )
            // Message search (R5) is a separate screen; the field above filters the inbox by title.
            if (search.isNotEmpty() && model.roomChats.protocols.search && model.can("agent_messaging.reveal_content") && model.can("agent_messaging.read")) {
                val normalized = normalizedQuery(search)
                TextButton(onClick = { model.openSearch(normalized) }, enabled = fresh, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("chat-search-messages")) {
                    CompanionIcon(CompanionSymbol.Search)
                    Spacer(Modifier.width(Space.s))
                    Text(if (normalized != null) stringResource(R.string.search_messages_for, normalized) else stringResource(R.string.search_messages), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        LazyColumn(Modifier.fillMaxSize().testTag("chat-list"), contentPadding = PaddingValues(bottom = 96.dp)) {
            if (!fresh && !model.connecting) item(key = "reconnect") {
                Row(Modifier.fillMaxWidth().padding(horizontal = Space.l, vertical = Space.xs), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.chat_checking), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = model::refreshNow, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.action_retry_connection)) }
                }
            }
            @Composable fun row(item: InboxItem, divider: Boolean) = when (item) {
                is InboxItem.Agent -> AgentRow(item.agent, now, fresh, attention(item.agent), model.unreadReplyCount(item.agent.getString("id")), divider) { model.openSession(item.agent.getString("id")) }
                is InboxItem.Room -> RoomRow(item.room, model.canOpenRoom(item.room), Instant.ofEpochMilli(now), model.roomChats.previews[item.room.getString("id")], divider) { model.openRoom(item.room) }
                is InboxItem.Approval -> ApprovalRow(item.request, now, divider) { onReview(item.request) }
            }
            if (needsYou.isNotEmpty()) {
                item(key = "section-needs-you") { InboxSection(stringResource(R.string.inbox_needs_you), needsYou.size, StatusRole.Attention) }
                itemsIndexed(needsYou, key = { _, item -> item.key }) { index, item -> row(item, index < needsYou.lastIndex) }
            }
            if (active.isNotEmpty()) {
                if (needsYou.isNotEmpty() || history) item(key = "section-active") {
                    InboxSection(stringResource(if (history) R.string.chat_conference_history else R.string.inbox_active), null, null)
                }
                itemsIndexed(active, key = { _, item -> item.key }) { index, item -> row(item, index < active.lastIndex) }
            }
            if (model.roomChats.nextOffset != null) item { TextButton(onClick = model.roomChats::more, enabled = fresh && !model.roomChats.loading, modifier = Modifier.padding(horizontal = Space.s)) { Text(stringResource(R.string.chat_more_conversations)) } }
            if (needsYou.isEmpty() && active.isEmpty()) item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(horizontal = Space.xl, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.s)) {
                    val empty = when {
                        model.connecting -> stringResource(R.string.chat_loading_chats)
                        search.isNotEmpty() -> stringResource(R.string.chat_none_found)
                        fresh && history -> stringResource(R.string.chat_no_closed_conferences)
                        fresh -> stringResource(R.string.chat_all_caught_up)
                        else -> stringResource(R.string.chat_waiting_for_chats)
                    }
                    if (model.connecting) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                    else CompanionIcon(CompanionSymbol.Chat, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(40.dp))
                    Text(empty, style = MaterialTheme.typography.titleMedium)
                    if (!model.connecting && search.isNotEmpty()) TextButton(onClick = { query = "" }, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.chat_clear_search)) }
                    else if (fresh && !history) Text(stringResource(R.string.chat_no_active_agents), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
        }
    }
}

@Composable private fun InboxSection(title: String, count: Int?, role: StatusRole?) {
    val compact = LocalConfiguration.current.screenHeightDp <= 680
    Row(Modifier.fillMaxWidth().padding(start = Space.l, end = Space.l, top = if (compact) Space.xs else Space.l,
        bottom = if (compact) 0.dp else Space.xs), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s)) {
        Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = role?.color() ?: MaterialTheme.colorScheme.onSurfaceVariant)
        if (count != null && count > 1) Text(count.toString(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A waiting host approval as an inbox row; tapping opens the existing review sheet. */
@Composable private fun ApprovalRow(request: JSONObject, now: Long, divider: Boolean, review: () -> Unit) {
    val remaining = runCatching { (Instant.parse(request.optString("expires_at")).toEpochMilli() - now) / 1000 }.getOrDefault(0).coerceAtLeast(0)
    InboxRowFrame(Modifier.testTag("approval-row:" + request.optString("id")), divider, review, avatar = {
        Surface(Modifier.size(48.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.onPrimaryContainer) {
            Box(contentAlignment = Alignment.Center) { CompanionIcon(CompanionSymbol.Shield) }
        }
    }, title = { Text(shortHostName(request.optString("fqdn")), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailing = { Text(stringResource(R.string.duration_m_s, remaining / 60, remaining % 60), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary) },
        subtitle = { Text(stringResource(R.string.inbox_approval_subtitle), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis) })
}

internal fun shortHostName(host: String): String = if (host.contains(':') || host.all { it.isDigit() || it == '.' }) host else host.substringBefore('.')

/** Leave the identity a full line when large text consumes the available phone width. */
@Composable private fun stackInboxMetadata(): Boolean =
    LocalConfiguration.current.screenWidthDp / LocalDensity.current.fontScale < 260

/** Shared two-line row anatomy for agents, rooms and approvals (docs/android-design.md). */
@Composable internal fun InboxRowFrame(modifier: Modifier, divider: Boolean, onClick: () -> Unit, avatar: @Composable () -> Unit,
    title: @Composable RowScope.() -> Unit, trailing: @Composable () -> Unit, subtitle: @Composable RowScope.() -> Unit, enabled: Boolean = true) {
    val compact = LocalConfiguration.current.screenHeightDp <= 680
    val stack = stackInboxMetadata()
    val inset = if (compact) Space.s else Space.l
    val gap = if (compact) Space.s else Space.m
    Surface(onClick = onClick, enabled = enabled, modifier = modifier.fillMaxWidth().heightIn(min = if (compact) 56.dp else 72.dp), shape = RectangleShape, color = MaterialTheme.colorScheme.background) {
        Column {
            Row(Modifier.fillMaxWidth().padding(horizontal = inset, vertical = if (compact) Space.xs else Space.m), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(gap)) {
                avatar()
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (stack) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, content = title)
                    } else {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s)) {
                            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, content = title)
                            trailing()
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s), content = subtitle)
                    if (stack) trailing()
                }
            }
            if (divider) HorizontalDivider(Modifier.padding(start = inset + 48.dp + gap), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
        }
    }
}

@Composable internal fun UnreadBadge(count: Int, modifier: Modifier = Modifier) {
    Surface(modifier.defaultMinSize(minWidth = 22.dp, minHeight = 22.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primary) {
        Box(Modifier.padding(horizontal = 6.dp, vertical = 2.dp), contentAlignment = Alignment.Center) {
            Text(if (count > 99) "99+" else count.toString(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimary)
        }
    }
}

internal fun roomCategory(room: JSONObject): String = when (room.optString("kind")) {
    "conference" -> "conference"; "project" -> "project"; "host" -> "host"; else -> "group"
}

@Composable private fun AgentRow(agent: JSONObject, now: Long, fresh: Boolean, attention: Boolean, unreadCount: Int, divider: Boolean, onClick: () -> Unit) {
    val t = rememberTexts()
    val timestamp = runCatching { Instant.parse(agent.optJSONObject("preview")?.optString("created_at").orEmpty().ifBlank { agent.optString("last_event_at") }) }.getOrNull()
    val host = agentHost(agent)
    val summary = agentSummary(t, agent)
    val unreadState = if (unreadCount == 0) stringResource(R.string.chat_read) else pluralStringResource(R.plurals.chat_unread_replies, unreadCount, unreadCount)
    val hostDescription = host?.let { stringResource(R.string.host_description, it) }.orEmpty()
    val unreadBadge = stringResource(R.string.chat_unread_badge)
    val role = agentRole(agent, now, fresh, attention)
    InboxRowFrame(Modifier.testTag("agent:" + agent.optString("id")).semantics { stateDescription = unreadState }, divider, onClick,
        avatar = { AgentAvatar(agent, role) },
        title = {
            val name = agentTitle(t, agent)
            if (stackInboxMetadata()) {
                Column {
                    Text(name, style = MaterialTheme.typography.titleMedium)
                    if (host != null) Text(shortHostName(host), Modifier.clearAndSetSemantics { contentDescription = hostDescription },
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                Text(name, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.titleMedium,
                    maxLines = if (LocalDensity.current.fontScale > 1.1f) 2 else 1, overflow = TextOverflow.Ellipsis)
                if (host != null) Text(" · " + shortHostName(host), Modifier.clearAndSetSemantics { contentDescription = hostDescription },
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
        },
        trailing = {
            timestamp?.let { Text(timeLabel(t, it, DateFormat.is24HourFormat(LocalContext.current)), style = MaterialTheme.typography.labelMedium,
                color = if (unreadCount > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
        },
        subtitle = {
            AgentStatusLine(agent, role, summary, attention, Modifier.weight(1f))
            if (unreadCount > 0) UnreadBadge(unreadCount, Modifier.testTag("unread-badge:" + agent.optString("id")).semantics { contentDescription = unreadBadge })
        })
}

/** The one-line status under an agent's name: what it does, then what it said last. */
@Composable internal fun AgentStatusLine(agent: JSONObject, role: StatusRole, summary: String?, attention: Boolean, modifier: Modifier = Modifier) {
    val word = statusWord(role)
    val text = when {
        attention -> summary ?: word
        role == StatusRole.Ready -> summary ?: word
        summary != null -> "$word · $summary"
        else -> word
    }
    Text(text, modifier.testTag("agent-status:" + agent.optString("id")), style = MaterialTheme.typography.bodyMedium,
        color = if (attention) role.color() else MaterialTheme.colorScheme.onSurfaceVariant,
        fontWeight = if (attention) FontWeight.Medium else null, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

@Composable internal fun statusWord(role: StatusRole): String = stringResource(when (role) {
    StatusRole.Ready -> R.string.status_ready
    StatusRole.Working -> R.string.status_working
    StatusRole.Waiting -> R.string.status_paused
    StatusRole.Attention -> R.string.status_waiting_you
    StatusRole.Error -> R.string.status_unknown
    StatusRole.Offline -> R.string.status_offline
})
