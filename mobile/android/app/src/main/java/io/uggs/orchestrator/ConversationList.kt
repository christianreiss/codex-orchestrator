package io.uggs.orchestrator

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.time.Instant

@Composable internal fun NowScreen(model: CompanionModel, agents: List<JSONObject>, requests: List<JSONObject>, fresh: Boolean, onReview: (JSONObject) -> Unit) {
    val attention = if (fresh && model.can("agent_portal.manage")) agents.filter { isReachable(it) && needsReply(it) } else emptyList()
    val remaining = agents.filterNot { agent -> attention.any { it.optString("id") == agent.optString("id") } }
    val unread = remaining.filter { it.optString("id") in model.unreadSessions }
    val ready = remaining.filterNot { it.optString("id") in model.unreadSessions }
    val urgent = requests.map { it to true } + attention.map { it to false }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp)) {
        if (!fresh) item {
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surface) {
                Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Checking what needs you…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedButton(onClick = model::refreshNow, modifier = Modifier.heightIn(min = 48.dp)) { Text("Retry connection") }
                }
            }
        }
        if (urgent.isNotEmpty()) item { SectionLabel("Needs you", urgent.size) }
        itemsIndexed(urgent, key = { _, entry -> (if (entry.second) "approval:" else "agent:") + entry.first.optString("id") }) { index, (item, approval) ->
            val shape = rowShape(index, urgent.size)
            if (approval) {
                Surface(onClick = { onReview(item) }, shape = shape, color = MaterialTheme.colorScheme.surface) {
                    Column {
                        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Surface(Modifier.size(46.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                                Box(contentAlignment = Alignment.Center) { CompanionIcon(CompanionSymbol.Shield, tint = MaterialTheme.colorScheme.primary) }
                            }
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(item.optString("fqdn"), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text("Review host access", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                            }
                            CompanionIcon(CompanionSymbol.Forward, tint = MaterialTheme.colorScheme.outline)
                        }
                        if (index < urgent.lastIndex) RowDivider()
                    }
                }
            } else AgentRow(item, true, item.optString("id") in model.unreadSessions, shape, index < urgent.lastIndex) { model.openSession(item.getString("id")) }
        }
        if (unread.isNotEmpty()) item { SectionLabel("Unread chats", unread.size) }
        itemsIndexed(unread, key = { _, agent -> agent.getString("id") }) { index, agent ->
            AgentRow(agent, false, true, rowShape(index, unread.size), index < unread.lastIndex) { model.openSession(agent.getString("id")) }
        }
        if (ready.isNotEmpty()) item { SectionLabel("Ready", ready.size) }
        itemsIndexed(ready, key = { _, agent -> agent.getString("id") }) { index, agent ->
            AgentRow(agent, false, false, rowShape(index, ready.size), index < ready.lastIndex) { model.openSession(agent.getString("id")) }
        }
        if (fresh && agents.isEmpty() && requests.isEmpty()) item {
            Column(Modifier.fillMaxWidth().padding(vertical = 64.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                    Box(Modifier.padding(20.dp)) { CompanionIcon(CompanionSymbol.Check, tint = MaterialTheme.colorScheme.primary) }
                }
                Text("All caught up", style = MaterialTheme.typography.headlineSmall)
                Text("No agents ready to talk.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

private fun rowShape(index: Int, count: Int) = RoundedCornerShape(
    topStart = if (index == 0) 22.dp else 0.dp, topEnd = if (index == 0) 22.dp else 0.dp,
    bottomStart = if (index == count - 1) 22.dp else 0.dp, bottomEnd = if (index == count - 1) 22.dp else 0.dp,
)

@Composable private fun SectionLabel(text: String, count: Int) {
    Row(Modifier.fillMaxWidth().padding(start = 5.dp, top = 20.dp, end = 5.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(count.toString(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun RowDivider() { HorizontalDivider(Modifier.padding(start = 72.dp, end = 14.dp), color = MaterialTheme.colorScheme.outlineVariant) }

@Composable private fun AgentRow(agent: JSONObject, attention: Boolean, unread: Boolean, shape: RoundedCornerShape, divider: Boolean, onClick: () -> Unit) {
    val timestamp = runCatching { Instant.parse(agent.optJSONObject("preview")?.optString("created_at").orEmpty().ifBlank { agent.optString("last_event_at") }) }.getOrNull()
    Surface(onClick = onClick, modifier = Modifier.testTag("agent:" + agent.optString("id")).semantics { stateDescription = if (unread) "Unread reply" else "Read" }, shape = shape, color = MaterialTheme.colorScheme.surface) {
        Column {
            Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                AgentAvatar(agent)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(agentTitle(agent), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (unread) Surface(Modifier.clearAndSetSemantics {}, shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                            Text("New", Modifier.padding(horizontal = 7.dp, vertical = 3.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimaryContainer)
                        }
                        timestamp?.let { Text(timeLabel(it, DateFormat.is24HourFormat(LocalContext.current)), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
                    }
                    HostBadge(agent)
                    agentSummary(agent)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    if (!isReachable(agent)) Text("Conversation history · read only", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (attention) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        Box(Modifier.size(6.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
                        Text("Reply needed", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            if (divider) RowDivider()
        }
    }
}
