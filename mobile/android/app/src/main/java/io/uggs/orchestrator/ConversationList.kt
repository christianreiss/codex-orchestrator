package io.uggs.orchestrator

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
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

@Composable internal fun NowScreen(model: CompanionModel, agents: List<JSONObject>, requests: List<JSONObject>, fresh: Boolean, onReview: (JSONObject) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf("all") }
    val keyboard = LocalSoftwareKeyboardController.current
    val search = query.trim()
    fun attention(agent: JSONObject) = fresh && model.can("agent_portal.manage") && isReachable(agent) && needsReply(agent)
    // Filter only the already-authorized overview. Searching never fetches a
    // transcript or changes a read marker, and host approvals stay pinned.
    val visible = agents.filter { agent ->
        val matchesFilter = when (filter) {
            "unread" -> model.unreadReplyCount(agent.getString("id")) > 0
            "needs-you" -> attention(agent)
            else -> true
        }
        matchesFilter && (search.isEmpty() || listOf(agentTitle(agent), agent.optString("cwd"),
            agentHost(agent).orEmpty(), agentSummary(agent).orEmpty(), agent.optString("engine"))
            .any { it.contains(search, ignoreCase = true) })
    }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 4.dp, bottom = 4.dp)) {
            OutlinedTextField(
                value = query, onValueChange = { query = it }, singleLine = true,
                modifier = Modifier.fillMaxWidth().testTag("chat-search").semantics { contentDescription = "Search chats" },
                placeholder = { Text("Search chats") },
                leadingIcon = { CompanionIcon(CompanionSymbol.Search, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
                trailingIcon = if (query.isNotEmpty()) { {
                    IconButton(onClick = { query = "" }, modifier = Modifier.size(48.dp)) { CompanionIcon(CompanionSymbol.Close, "Clear search") }
                } } else null,
                shape = RoundedCornerShape(28.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    focusedBorderColor = Color.Transparent, unfocusedBorderColor = Color.Transparent,
                ),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
            )
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("all" to "All", "unread" to "Unread", "needs-you" to "Needs you").forEach { (id, label) ->
                    FilterChip(
                        selected = filter == id, onClick = { filter = id },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("chat-filter:$id"),
                        label = { Text(label) }, shape = CircleShape, border = null,
                        colors = FilterChipDefaults.filterChipColors(
                            containerColor = MaterialTheme.colorScheme.surfaceContainer,
                            labelColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
                            selectedLabelColor = MaterialTheme.colorScheme.onPrimaryContainer,
                        ),
                    )
                }
            }
        }
        LazyColumn(Modifier.fillMaxSize().testTag("chat-list"), contentPadding = PaddingValues(bottom = 96.dp)) {
            if (!fresh && !model.connecting) item(key = "reconnect") {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Text("Checking what needs you…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = model::refreshNow, modifier = Modifier.heightIn(min = 48.dp)) { Text("Retry connection") }
                }
            }
            itemsIndexed(requests, key = { _, request -> "approval:" + request.optString("id") }) { _, request ->
                ApprovalRow(request) { onReview(request) }
            }
            itemsIndexed(visible, key = { _, agent -> "agent:" + agent.getString("id") }) { index, agent ->
                AgentRow(agent, attention(agent), model.unreadReplyCount(agent.getString("id")), index < visible.lastIndex) { model.openSession(agent.getString("id")) }
            }
            if (visible.isEmpty() && (requests.isEmpty() || search.isNotEmpty() || filter != "all")) item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val empty = when {
                        model.connecting -> "Loading your chats…"
                        search.isNotEmpty() -> "No chats found"
                        filter == "unread" -> "No unread chats"
                        filter == "needs-you" -> "No chats need you"
                        fresh -> "All caught up"
                        else -> "Waiting for chats"
                    }
                    if (model.connecting) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                    Text(empty, style = MaterialTheme.typography.titleMedium)
                    if (!model.connecting && (search.isNotEmpty() || filter != "all")) TextButton(onClick = { query = ""; filter = "all" }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Clear filters") }
                    else if (fresh) Text("No agents ready to talk.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable private fun ApprovalRow(request: JSONObject, onClick: () -> Unit) {
    Surface(onClick = onClick, modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp).testTag("approval:" + request.optString("id")), shape = RectangleShape, color = MaterialTheme.colorScheme.background) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Surface(Modifier.size(52.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                Box(contentAlignment = Alignment.Center) { CompanionIcon(CompanionSymbol.Shield, tint = MaterialTheme.colorScheme.primary) }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(request.optString("fqdn"), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Review host access", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
            }
            CompanionIcon(CompanionSymbol.Forward, tint = MaterialTheme.colorScheme.outline)
        }
    }
}

@Composable private fun AgentRow(agent: JSONObject, attention: Boolean, unreadCount: Int, divider: Boolean, onClick: () -> Unit) {
    val timestamp = runCatching { Instant.parse(agent.optJSONObject("preview")?.optString("created_at").orEmpty().ifBlank { agent.optString("last_event_at") }) }.getOrNull()
    val host = agentHost(agent)
    val shortHost = host?.let { if (it.contains(':') || it.all { char -> char.isDigit() || char == '.' }) it else it.substringBefore('.') }
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
                            if (summary != null) Text(" · ", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.outline)
                        }
                        if (summary != null) Text(summary, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (attention) Text("Reply needed", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
                Column(Modifier.align(Alignment.Top).padding(top = 2.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(Modifier.heightIn(min = 18.dp)) {
                        timestamp?.let { Text(timeLabel(it, DateFormat.is24HourFormat(LocalContext.current)), style = MaterialTheme.typography.labelSmall,
                            color = if (unreadCount > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
                    }
                    if (unreadCount > 0) Surface(Modifier.clearAndSetSemantics {}.defaultMinSize(minWidth = 24.dp, minHeight = 24.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primary) {
                        Box(Modifier.padding(horizontal = 6.dp, vertical = 3.dp), contentAlignment = Alignment.Center) {
                            Text(if (unreadCount > 99) "99+" else unreadCount.toString(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimary)
                        }
                    }
                }
            }
            if (divider) HorizontalDivider(Modifier.padding(start = 80.dp, end = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))
        }
    }
}
