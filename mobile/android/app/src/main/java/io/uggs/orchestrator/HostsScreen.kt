package io.uggs.orchestrator

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.animation.animateContentSize
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.delay
import androidx.compose.ui.unit.dp
import org.json.JSONObject

internal fun remoteStatus(status: String) = when (status) {
    "queued" -> "Start queued — waiting for the host"
    "running" -> "Agent is working"
    "stopping" -> "Agent is stopping"
    "idle" -> "Ready for your next instruction"
    "waiting" -> "Your reply is needed"
    "unknown" -> "Outcome unknown — inspect the session on the host"
    "failed" -> "Start or execution failed"
    "closed" -> "Session closed"
    else -> "Waiting for the agent"
}

internal fun defaultHostEngine(host: JSONObject): String? {
    val engines = host.optJSONArray("engines")?.strings() ?: emptySet()
    return if ("codex" in engines) "codex" else listOf("claude", "grok").firstOrNull { it in engines }
}

internal fun hostReason(host: JSONObject): String {
    val reasons = host.optJSONObject("health")?.optJSONArray("reasons")?.strings() ?: emptySet()
    return when {
        "messaging_or_api_disabled" in reasons -> "Remote starts are disabled"
        "host_access_blocked" in reasons -> "Host access is blocked"
        "installation_pending" in reasons -> "Waiting for daemon installation"
        "heartbeat_expired" in reasons -> "Host is offline"
        "reconnecting" in reasons -> "Host is reconnecting"
        "service_user_mismatch" in reasons -> "Daemon service user does not match"
        "daemon_error" in reasons -> "Daemon needs attention"
        "no_engine_ready" in reasons || defaultHostEngine(host) == null -> "No engine is ready"
        host.optInt("free_slots") == 0 -> "All slots are occupied"
        else -> "${host.optInt("free_slots")} free slots · ${host.optJSONArray("engines")?.strings()?.joinToString(" · ").orEmpty()}"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun HostsScreen(model: CompanionModel, fresh: Boolean) {
    val haptic = LocalHapticFeedback.current
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(refreshing) { if (refreshing) { delay(900); refreshing = false } }
    var query by rememberSaveable { mutableStateOf("") }
    var start by rememberSaveable { mutableStateOf<Long?>(null) }
    val hosts = model.hosts.filter { it.optString("fqdn").contains(query.trim(), ignoreCase = true) }
        .sortedWith(compareByDescending<JSONObject> { it.optBoolean("startable") }.thenBy { it.optString("fqdn") })
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            query, { query = it }, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("host-search"), singleLine = true,
            placeholder = { Text("Search hosts") }, leadingIcon = { CompanionIcon(CompanionSymbol.Search, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
            shape = MaterialTheme.shapes.medium, colors = searchFieldColors(),
        )
        model.pendingStart?.let {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                Text("Start outcome pending. Retry checks the same start; it does not create a second agent.", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { model.retryStart() }, enabled = model.canSpawn() && !model.busy, modifier = Modifier.testTag("retry-start")) { Text("Retry start") }
            }
        }
        if (!fresh) Text("Reconnect to start an agent", Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        else if (!model.canSpawn()) Text("Remote starts need messaging and portal permissions", Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { refreshing = true; model.refreshNow() }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().testTag("host-list"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (hosts.isEmpty() && model.hosts.isEmpty() && !fresh) item { SkeletonCards(3) }
            else if (hosts.isEmpty()) item { EmptyState(if (query.isBlank()) "No hosts with remote starts enabled" else "No matching hosts") }
            items(hosts, key = { it.optLong("host_id") }) { host ->
                val startable = host.optBoolean("startable")
                val hostName = host.optString("fqdn")
                Card(Modifier.fillMaxWidth().animateContentSize(), colors = companionCardColors(), border = companionCardBorder()) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).semantics(mergeDescendants = true) { }.padding(start = 16.dp, end = 12.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(contentAlignment = Alignment.BottomEnd) {
                            CompanionIcon(CompanionSymbol.Computer, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            StatusDot(startable, Modifier.size(9.dp).offset(x = 3.dp, y = 3.dp).clearAndSetSemantics { })
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(hostName, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                            Text(hostReason(host), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        val canStart = fresh && model.canSpawn() && startable && !model.busy && model.pendingStart == null
                        val startModifier = Modifier.heightIn(min = 48.dp).testTag("spawn:${host.optLong("host_id")}")
                        val startDescription = stringResource(R.string.start_host_description, hostName)
                        if (canStart) FilledTonalButton(onClick = { haptic.performHapticFeedback(HapticFeedbackType.ContextClick); start = host.optLong("host_id") }, modifier = startModifier.semantics { contentDescription = startDescription }) { Text("Start") }
                        else OutlinedButton(onClick = { }, enabled = false, modifier = startModifier.semantics { contentDescription = startDescription }) { Text("Start") }
                    }
                }
            }
        }
        }
    }
    start?.let { id -> model.hosts.firstOrNull { it.optLong("host_id") == id }?.let { host -> StartAgentSheet(model, host, onDismiss = { start = null }) } }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun StartAgentSheet(model: CompanionModel, host: JSONObject, onDismiss: () -> Unit) {
    var engine by rememberSaveable(host.optLong("host_id")) { mutableStateOf(defaultHostEngine(host).orEmpty()) }
    var task by rememberSaveable { mutableStateOf("") }
    var title by rememberSaveable { mutableStateOf("") }
    var cwd by rememberSaveable { mutableStateOf(host.optString("default_cwd")) }
    var advanced by rememberSaveable { mutableStateOf(false) }
    val engines = host.optJSONArray("engines")?.strings() ?: emptySet()
    val ready = model.canSpawn() && host.optBoolean("startable") && engine in engines && (cwd.isBlank() || cwd.startsWith('/'))
    ModalBottomSheet(onDismissRequest = onDismiss, shape = SheetShape, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Start an agent", style = MaterialTheme.typography.titleLarge)
            Text(host.optString("fqdn"), style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("codex", "claude", "grok").filter { it in engines }.forEach { value -> FilterChip(selected = engine == value, onClick = { engine = value }, label = { Text(value.replaceFirstChar { it.uppercase() }) }, enabled = !model.busy && model.pendingStart == null) }
            }
            OutlinedTextField(task, { task = it.take(32768) }, label = { Text("Task (optional)") }, placeholder = { Text("Leave empty to establish contact") }, modifier = Modifier.fillMaxWidth().testTag("spawn-task"), minLines = 2, maxLines = 5, enabled = !model.busy && model.pendingStart == null)
            Text(if (task.isBlank()) "The agent will greet you in the portal and wait for your instruction." else "The agent will greet you, then work on this task and report in the portal.", style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { advanced = !advanced }) { Text(if (advanced) "Fewer options" else "More options") }
            if (advanced) {
                OutlinedTextField(title, { title = it.take(160) }, label = { Text("Title (optional)") }, modifier = Modifier.fillMaxWidth(), singleLine = true, enabled = !model.busy && model.pendingStart == null)
                OutlinedTextField(cwd, { cwd = it.take(1024) }, label = { Text("Working directory") }, supportingText = { Text("Use an existing absolute directory on the host") }, modifier = Modifier.fillMaxWidth(), singleLine = true, enabled = !model.busy && model.pendingStart == null)
            }
            if (!host.optBoolean("startable")) Text(hostReason(host), color = MaterialTheme.colorScheme.error)
            if (model.pendingStart != null) TextButton(onClick = { model.retryStart(onDismiss) }, enabled = ready && !model.busy) { Text("Retry same start") }
            else Button(onClick = { model.startHost(host.optLong("host_id"), engine, task, title, cwd, onDismiss) }, enabled = ready && !model.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("confirm-spawn")) { Text(if (task.isBlank()) "Establish contact" else "Start with task") }
        }
    }
}
