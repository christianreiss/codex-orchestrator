package io.uggs.orchestrator

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.time.Instant

@Composable internal fun AuthorizationsScreen(model: CompanionModel, fresh: Boolean, now: Long, onReview: (JSONObject) -> Unit) {
    var confirmFleetClose by remember { mutableStateOf(false) }
    val requests = model.approvals.filter { liveApproval(it, now) }
    val windows = model.activeWindows.filter { liveWindow(it, now) }
    val fleetOpen = liveFleetWindow(model.fleetWindow, now)
    val actionable = fresh && model.can("hosts.activate_insecure") && !model.busy

    LazyColumn(Modifier.fillMaxSize().testTag("authorizations-list"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 96.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (!fresh) item {
            Text("Reconnect to manage authorizations. Displayed windows may have changed.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = model::refreshNow) { Text("Retry connection") }
        }
        item { SectionHeader("Waiting authorizations", requests.size) }
        if (requests.isEmpty()) item { EmptyState(if (fresh) "No waiting authorizations" else "Waiting for current authorizations", modifier = Modifier.padding(vertical = 0.dp)) }
        items(requests, key = { "approval:${it.optLong("id")}" }) { request ->
            Card(colors = companionCardColors(), border = companionCardBorder(), modifier = Modifier.fillMaxWidth().testTag("approval:${request.optLong("id")}")) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(request.optString("fqdn"), style = MaterialTheme.typography.titleMedium)
                    Text("Requesting IP: ${request.optString("request_ip")}")
                    Text("Expires in ${remainingWindowTime(request.optString("expires_at"), now)}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = { onReview(request) }, enabled = actionable, modifier = Modifier.heightIn(min = 48.dp)) { Text("Review") }
                }
            }
        }
        item { SectionHeader("Active windows", windows.size + if (fleetOpen) 1 else 0, Modifier.padding(top = 8.dp)) }
        if (fleetOpen) item(key = "fleet-window") {
            Card(colors = companionCardColors(), border = companionCardBorder(), modifier = Modifier.fillMaxWidth().testTag("fleet-window")) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Fleet window", style = MaterialTheme.typography.titleMedium)
                    WindowDeadline(model.fleetWindow!!, now)
                    Text("Allows access for every insecure host.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedButton(onClick = { confirmFleetClose = true }, enabled = actionable, modifier = Modifier.heightIn(min = 48.dp).testTag("close-fleet-window")) { Text("Close fleet window") }
                }
            }
        }
        items(windows, key = { "window:${it.optLong("host_id")}" }) { window ->
            Card(colors = companionCardColors(), border = companionCardBorder(), modifier = Modifier.fillMaxWidth().testTag("window:${window.optLong("host_id")}")) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(window.optString("fqdn"), style = MaterialTheme.typography.titleMedium)
                    WindowDeadline(window, now)
                    if (fleetOpen) Text("Close the fleet window first to disable host access.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (!window.isNull("domain_allow") && window.optString("domain_allow").isNotBlank())
                        Text("Domain grant ${window.optString("domain_allow")} may reopen this host on its next request.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedButton(onClick = { model.closeWindow(window.optLong("host_id")) }, enabled = actionable && !fleetOpen, modifier = Modifier.heightIn(min = 48.dp).testTag("close-window:${window.optLong("host_id")}")) { Text("Close") }
                }
            }
        }
        if (windows.isEmpty() && !fleetOpen) item { EmptyState(if (fresh) "No active windows" else "Waiting for current windows") }
    }
    if (confirmFleetClose) AlertDialog(
        modifier = Modifier.testTag("fleet-close-dialog"),
        onDismissRequest = { if (!model.busy) confirmFleetClose = false },
        title = { Text("Close fleet access?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("This closes all host windows and active domain grants. New insecure access requires authorization again.")
                model.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { TextButton(onClick = { model.closeFleetWindow { confirmFleetClose = false } }, enabled = actionable && fleetOpen, modifier = Modifier.testTag("confirm-close-fleet")) { Text("Close all access") } },
        dismissButton = { TextButton(onClick = { confirmFleetClose = false }, enabled = !model.busy) { Text("Cancel") } },
    )
}

@Composable private fun WindowDeadline(window: JSONObject, now: Long) {
    val deadline = window.optString("enabled_until")
    val context = androidx.compose.ui.platform.LocalContext.current
    val local = runCatching {
        val date = java.util.Date.from(Instant.parse(deadline))
        "${android.text.format.DateFormat.getDateFormat(context).format(date)} ${android.text.format.DateFormat.getTimeFormat(context).format(date)}"
    }.getOrDefault(deadline)
    Text("Until $local · ${remainingWindowTime(deadline, now)} remaining", color = MaterialTheme.colorScheme.onSurfaceVariant)
}

internal fun remainingWindowTime(deadline: String, now: Long): String {
    val seconds = runCatching { (Instant.parse(deadline).toEpochMilli() - now).coerceAtLeast(0) / 1000 }.getOrDefault(0)
    return if (seconds >= 3600) "${seconds / 3600}h ${(seconds % 3600) / 60}m" else "${seconds / 60}m ${seconds % 60}s"
}
