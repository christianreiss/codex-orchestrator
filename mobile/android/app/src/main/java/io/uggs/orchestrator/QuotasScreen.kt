package io.uggs.orchestrator

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

internal fun quotaDataStatus(account: JSONObject, now: Long): String {
    val windows = account.optJSONArray("windows")?.objects().orEmpty()
    if (windows.isEmpty()) return "Unavailable"
    val fetched = runCatching { Instant.parse(account.optString("fetched_at")).toEpochMilli() }.getOrNull()
    val expired = windows.any { runCatching { Instant.parse(it.optString("resets_at")).toEpochMilli() <= now }.getOrDefault(false) }
    return if (account.optBoolean("stale", true) || fetched == null || now - fetched !in 0..600_000 || expired) "Stale" else "Current"
}
internal fun quotaWindowLabel(window: JSONObject): String = when (window.optString("kind")) {
    "weekly" -> "Weekly"
    "monthly" -> "Monthly"
    "short" -> window.optLong("limit_seconds").takeIf { it > 0 && it % 3600 == 0L }?.let { "${it / 3600} hours" } ?: "Short window"
    else -> "Current window"
}
private fun quotaTime(raw: String): String? = runCatching {
    DateTimeFormatter.ofPattern("d MMM, HH:mm", Locale.getDefault()).withZone(ZoneId.systemDefault()).format(Instant.parse(raw))
}.getOrNull()

@Composable internal fun QuotasScreen(model: CompanionModel) {
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            launch { while (true) { model.refreshQuotas(); delay(60_000) } }
            while (true) { now = System.currentTimeMillis(); delay(1000) }
        }
    }
    LazyColumn(Modifier.fillMaxSize().testTag("quotas-screen"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Engine quotas", Modifier.weight(1f), style = MaterialTheme.typography.headlineSmall)
                TextButton(onClick = { scope.launch { model.refreshQuotas() } }, enabled = !model.quotaLoading) { Text("Refresh") }
            }
            Text("Usage per account · times are local", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (model.quotaLoading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
            if (!model.fresh()) Text("Server disconnected · showing the last quota snapshot", color = MaterialTheme.colorScheme.onSurfaceVariant)
            model.quotaError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (model.quotaEngines.isEmpty() && !model.quotaLoading && model.quotaError == null) Text("No quota data available.")
        }
        model.quotaEngines.forEach { engine ->
            item(key = engine.getString("engine")) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    EngineIcon(engine)
                    Text(engine.getString("label"), style = MaterialTheme.typography.titleLarge)
                    if (!engine.optBoolean("enabled", true)) Text("Suspended", style = MaterialTheme.typography.labelMedium)
                }
                if (engine.optJSONArray("accounts")?.length() == 0) Text("No accounts", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(engine.optJSONArray("accounts")?.objects().orEmpty(), key = { "${engine.getString("engine")}:${it.getInt("id")}" }) { account ->
                OutlinedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(account.optString("label"), style = MaterialTheme.typography.titleMedium)
                        val status = quotaDataStatus(account, now)
                        Text("${account.optString("state")} · $status", style = MaterialTheme.typography.bodySmall,
                            color = if (status == "Current") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)
                        account.optJSONArray("windows")?.objects()?.forEach { window ->
                            val percent = window.optDouble("used_percent", Double.NaN)
                            Text("${quotaWindowLabel(window)} · ${if (percent.isFinite()) String.format(Locale.getDefault(), "%.1f%% used", percent) else "Unavailable"}")
                            if (percent.isFinite()) LinearProgressIndicator(progress = { (percent / 100).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                            quotaTime(window.optString("resets_at"))?.let { Text("Resets $it", style = MaterialTheme.typography.bodySmall) }
                        }
                        quotaTime(account.optString("fetched_at"))?.let { Text("Updated $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
        }
    }
}
