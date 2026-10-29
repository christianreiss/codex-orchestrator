package io.uggs.orchestrator

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.animation.animateContentSize
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.delay
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.time.Instant

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun AuthorizationsScreen(model: CompanionModel, fresh: Boolean, now: Long, onReview: (JSONObject) -> Unit) {
    var confirmFleetClose by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(refreshing) { if (refreshing) { delay(900); refreshing = false } }
    val haptic = LocalHapticFeedback.current
    val t = rememberTexts()
    val requests = model.approvals.filter { liveApproval(it, now) }
    val windows = model.activeWindows.filter { liveWindow(it, now) }
    val fleetOpen = liveFleetWindow(model.fleetWindow, now)
    val actionable = fresh && model.can("hosts.activate_insecure") && !model.busy

    PullToRefreshBox(isRefreshing = refreshing, onRefresh = { refreshing = true; model.refreshNow() }, modifier = Modifier.fillMaxSize()) {
    LazyColumn(Modifier.fillMaxSize().testTag("authorizations-list"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 96.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (!fresh) item {
            StatusChip(stringResource(R.string.auth_reconnect), MaterialTheme.status.warningContainer, MaterialTheme.status.onWarningContainer)
            TextButton(onClick = model::refreshNow) { Text(stringResource(R.string.action_retry_connection)) }
        }
        item { SectionHeader(stringResource(R.string.auth_waiting_title), requests.size) }
        if (requests.isEmpty()) item { EmptyState(stringResource(if (fresh) R.string.auth_none_waiting else R.string.auth_waiting_current), modifier = Modifier.padding(vertical = 0.dp)) }
        items(requests, key = { "approval:${it.optLong("id")}" }) { request ->
            Card(colors = companionCardColors(), border = companionCardBorder(), modifier = Modifier.fillMaxWidth().animateContentSize().testTag("approval:${request.optLong("id")}")) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Column(Modifier.semantics(mergeDescendants = true) { }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(request.optString("fqdn"), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.auth_requesting_ip, request.optString("request_ip")))
                        Text(stringResource(R.string.auth_expires_in, remainingWindowTime(t, request.optString("expires_at"), now)), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    val reviewDescription = stringResource(R.string.review_request_description, request.optString("fqdn"))
                    Button(onClick = { haptic.performHapticFeedback(HapticFeedbackType.ContextClick); onReview(request) }, enabled = actionable, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = reviewDescription }) { Text(stringResource(R.string.auth_review)) }
                }
            }
        }
        item { SectionHeader(stringResource(R.string.auth_active_windows), windows.size + if (fleetOpen) 1 else 0, Modifier.padding(top = 8.dp)) }
        if (fleetOpen) item(key = "fleet-window") {
            Card(colors = companionCardColors(), border = companionCardBorder(), modifier = Modifier.fillMaxWidth().testTag("fleet-window")) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(stringResource(R.string.auth_fleet_window), style = MaterialTheme.typography.titleMedium)
                    WindowDeadline(model.fleetWindow!!, now)
                    Text(stringResource(R.string.auth_fleet_window_hint), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedButton(onClick = { confirmFleetClose = true }, enabled = actionable, modifier = Modifier.heightIn(min = 48.dp).testTag("close-fleet-window")) { Text(stringResource(R.string.auth_close_fleet_window)) }
                }
            }
        }
        items(windows, key = { "window:${it.optLong("host_id")}" }) { window ->
            Card(colors = companionCardColors(), border = companionCardBorder(), modifier = Modifier.fillMaxWidth().testTag("window:${window.optLong("host_id")}")) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(window.optString("fqdn"), style = MaterialTheme.typography.titleMedium)
                    WindowDeadline(window, now)
                    if (fleetOpen) Text(stringResource(R.string.auth_close_fleet_first), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (!window.isNull("domain_allow") && window.optString("domain_allow").isNotBlank())
                        Text(stringResource(R.string.auth_domain_grant, window.optString("domain_allow")), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedButton(onClick = { model.closeWindow(window.optLong("host_id")) }, enabled = actionable && !fleetOpen, modifier = Modifier.heightIn(min = 48.dp).testTag("close-window:${window.optLong("host_id")}")) { Text(stringResource(R.string.action_close)) }
                }
            }
        }
        if (windows.isEmpty() && !fleetOpen) item { EmptyState(stringResource(if (fresh) R.string.auth_none_active else R.string.auth_waiting_windows)) }
    }
    }
    if (confirmFleetClose) AlertDialog(
        modifier = Modifier.testTag("fleet-close-dialog"),
        onDismissRequest = { if (!model.busy) confirmFleetClose = false },
        title = { Text(stringResource(R.string.auth_close_fleet_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.auth_close_fleet_body))
                model.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { TextButton(onClick = { model.closeFleetWindow { confirmFleetClose = false } }, enabled = actionable && fleetOpen, modifier = Modifier.testTag("confirm-close-fleet")) { Text(stringResource(R.string.auth_close_all)) } },
        dismissButton = { TextButton(onClick = { confirmFleetClose = false }, enabled = !model.busy) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable private fun WindowDeadline(window: JSONObject, now: Long) {
    val deadline = window.optString("enabled_until")
    val context = androidx.compose.ui.platform.LocalContext.current
    val t = rememberTexts()
    val local = runCatching {
        val date = java.util.Date.from(Instant.parse(deadline))
        t.string(R.string.auth_date_time, android.text.format.DateFormat.getDateFormat(context).format(date), android.text.format.DateFormat.getTimeFormat(context).format(date))
    }.getOrDefault(deadline)
    val remaining = remainingWindowTime(t, deadline, now)
    val soon = runCatching { Instant.parse(deadline).toEpochMilli() - now < 5 * 60_000 }.getOrDefault(false)
    Text(stringResource(R.string.auth_until, local, remaining), color = if (soon) MaterialTheme.status.warning else MaterialTheme.colorScheme.onSurfaceVariant)
}

internal fun remainingWindowTime(t: Texts, deadline: String, now: Long): String {
    val seconds = runCatching { (Instant.parse(deadline).toEpochMilli() - now).coerceAtLeast(0) / 1000 }.getOrDefault(0)
    return if (seconds >= 3600) t.string(R.string.duration_h_m, seconds / 3600, (seconds % 3600) / 60) else t.string(R.string.duration_m_s, seconds / 60, seconds % 60)
}
