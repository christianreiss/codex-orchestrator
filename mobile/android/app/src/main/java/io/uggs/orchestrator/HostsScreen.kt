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

internal fun remoteStatus(t: Texts, status: String) = t.string(when (status) {
    "queued" -> R.string.remote_queued
    "running" -> R.string.remote_running
    "stopping" -> R.string.remote_stopping
    "idle" -> R.string.remote_idle
    "waiting" -> R.string.remote_waiting
    "unknown" -> R.string.remote_unknown
    "failed" -> R.string.remote_failed
    "closed" -> R.string.remote_closed
    else -> R.string.remote_default
})

internal fun defaultHostEngine(host: JSONObject): String? {
    val engines = host.optJSONArray("engines")?.strings() ?: emptySet()
    return if ("codex" in engines) "codex" else listOf("claude", "grok").firstOrNull { it in engines }
}

internal fun hostReason(t: Texts, host: JSONObject): String {
    val reasons = host.optJSONObject("health")?.optJSONArray("reasons")?.strings() ?: emptySet()
    return when {
        "messaging_or_api_disabled" in reasons -> t.string(R.string.host_reason_disabled)
        "host_access_blocked" in reasons -> t.string(R.string.host_reason_blocked)
        "installation_pending" in reasons -> t.string(R.string.host_reason_installing)
        "heartbeat_expired" in reasons -> t.string(R.string.host_reason_offline)
        "reconnecting" in reasons -> t.string(R.string.host_reason_reconnecting)
        "service_user_mismatch" in reasons -> t.string(R.string.host_reason_user_mismatch)
        "daemon_error" in reasons -> t.string(R.string.host_reason_daemon_error)
        "no_engine_ready" in reasons || defaultHostEngine(host) == null -> t.string(R.string.host_reason_no_engine)
        host.optInt("free_slots") == 0 -> t.string(R.string.host_reason_no_slots)
        else -> t.plural(R.plurals.host_reason_free_slots, host.optInt("free_slots"), host.optInt("free_slots"), host.optJSONArray("engines")?.strings()?.joinToString(" · ").orEmpty())
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun HostsScreen(model: CompanionModel, fresh: Boolean) {
    val haptic = LocalHapticFeedback.current
    val t = rememberTexts()
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(refreshing) { if (refreshing) { delay(900); refreshing = false } }
    var query by rememberSaveable { mutableStateOf("") }
    var start by rememberSaveable { mutableStateOf<Long?>(null) }
    val hosts = model.hosts.filter { it.optString("fqdn").contains(query.trim(), ignoreCase = true) }
        .sortedWith(compareByDescending<JSONObject> { it.optBoolean("startable") }.thenBy { it.optString("fqdn") })
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            query, { query = it }, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("host-search"), singleLine = true,
            placeholder = { Text(stringResource(R.string.hosts_search)) }, leadingIcon = { CompanionIcon(CompanionSymbol.Search, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
            shape = MaterialTheme.shapes.medium, colors = searchFieldColors(),
        )
        model.pendingStart?.let {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                Text(stringResource(R.string.hosts_start_pending), style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { model.retryStart() }, enabled = model.canSpawn() && !model.busy, modifier = Modifier.testTag("retry-start")) { Text(stringResource(R.string.hosts_retry_start)) }
            }
        }
        if (!fresh) Text(stringResource(R.string.hosts_reconnect_to_start), Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        else if (!model.canSpawn()) Text(stringResource(R.string.hosts_need_permissions), Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { refreshing = true; model.refreshNow() }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().testTag("host-list"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (hosts.isEmpty() && model.hosts.isEmpty() && !fresh) item { SkeletonCards(3) }
            else if (hosts.isEmpty()) item { EmptyState(stringResource(if (query.isBlank()) R.string.hosts_none else R.string.hosts_no_match)) }
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
                            Text(hostReason(t, host), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        val canStart = fresh && model.canSpawn() && startable && !model.busy && model.pendingStart == null
                        val startModifier = Modifier.heightIn(min = 48.dp).testTag("spawn:${host.optLong("host_id")}")
                        val startDescription = stringResource(R.string.start_host_description, hostName)
                        if (canStart) FilledTonalButton(onClick = { haptic.performHapticFeedback(HapticFeedbackType.ContextClick); start = host.optLong("host_id") }, modifier = startModifier.semantics { contentDescription = startDescription }) { Text(stringResource(R.string.action_start)) }
                        else OutlinedButton(onClick = { }, enabled = false, modifier = startModifier.semantics { contentDescription = startDescription }) { Text(stringResource(R.string.action_start)) }
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
            Text(stringResource(R.string.start_title), style = MaterialTheme.typography.titleLarge)
            Text(host.optString("fqdn"), style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("codex", "claude", "grok").filter { it in engines }.forEach { value -> FilterChip(selected = engine == value, onClick = { engine = value }, label = { Text(value.replaceFirstChar { it.uppercase() }) }, enabled = !model.busy && model.pendingStart == null) }
            }
            OutlinedTextField(task, { task = it.take(32768) }, label = { Text(stringResource(R.string.start_task)) }, placeholder = { Text(stringResource(R.string.start_task_hint)) }, modifier = Modifier.fillMaxWidth().testTag("spawn-task"), minLines = 2, maxLines = 5, enabled = !model.busy && model.pendingStart == null)
            Text(stringResource(if (task.isBlank()) R.string.start_greet_only else R.string.start_greet_task), style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { advanced = !advanced }) { Text(stringResource(if (advanced) R.string.start_fewer_options else R.string.start_more_options)) }
            if (advanced) {
                OutlinedTextField(title, { title = it.take(160) }, label = { Text(stringResource(R.string.start_title_optional)) }, modifier = Modifier.fillMaxWidth(), singleLine = true, enabled = !model.busy && model.pendingStart == null)
                OutlinedTextField(cwd, { cwd = it.take(1024) }, label = { Text(stringResource(R.string.start_cwd)) }, supportingText = { Text(stringResource(R.string.start_cwd_hint)) }, modifier = Modifier.fillMaxWidth(), singleLine = true, enabled = !model.busy && model.pendingStart == null)
            }
            if (!host.optBoolean("startable")) Text(hostReason(rememberTexts(), host), color = MaterialTheme.colorScheme.error)
            if (model.pendingStart != null) TextButton(onClick = { model.retryStart(onDismiss) }, enabled = ready && !model.busy) { Text(stringResource(R.string.start_retry_same)) }
            else Button(onClick = { model.startHost(host.optLong("host_id"), engine, task, title, cwd, onDismiss) }, enabled = ready && !model.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("confirm-spawn")) { Text(stringResource(if (task.isBlank()) R.string.start_establish_contact else R.string.start_with_task)) }
        }
    }
}
