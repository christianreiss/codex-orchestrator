package io.uggs.orchestrator

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
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

@OptIn(ExperimentalMaterial3Api::class)
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
    PullToRefreshBox(isRefreshing = model.quotaLoading, onRefresh = { scope.launch { model.refreshQuotas() } }, modifier = Modifier.fillMaxSize()) {
    LazyColumn(Modifier.fillMaxSize().testTag("quotas-screen"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            val haptic = LocalHapticFeedback.current
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Engine quotas", Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.headlineSmall)
                TextButton(onClick = { haptic.performHapticFeedback(HapticFeedbackType.ContextClick); scope.launch { model.refreshQuotas() } }, enabled = !model.quotaLoading) { Text("Refresh") }
            }
            Text("Usage per account · times are local", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (model.quotaLoading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
            if (!model.fresh()) StatusChip("Server disconnected · showing the last quota snapshot", MaterialTheme.status.warningContainer, MaterialTheme.status.onWarningContainer, Modifier.padding(top = 8.dp))
            model.quotaError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (model.quotaEngines.isEmpty() && !model.quotaLoading && model.quotaError == null) Text("No quota data available.")
            if (model.quotaEngines.isEmpty() && model.quotaLoading) SkeletonCards(2, Modifier.padding(top = 8.dp))
        }
        model.quotaEngines.forEach { engine ->
            item(key = engine.getString("engine")) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    EngineIcon(engine)
                    Text(engine.getString("label"), style = MaterialTheme.typography.titleLarge)
                    if (!engine.optBoolean("enabled", true)) StatusChip("Suspended", MaterialTheme.status.warningContainer, MaterialTheme.status.onWarningContainer)
                }
                if (engine.optJSONArray("accounts")?.length() == 0) Text("No accounts", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(engine.optJSONArray("accounts")?.objects().orEmpty(), key = { "${engine.getString("engine")}:${it.getInt("id")}" }) { account ->
                OutlinedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(account.optString("label"), style = MaterialTheme.typography.titleMedium)
                        val status = quotaDataStatus(account, now)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(account.optString("state"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            when (status) {
                                "Current" -> StatusChip(status, MaterialTheme.status.successContainer, MaterialTheme.status.onSuccessContainer)
                                else -> StatusChip(status, MaterialTheme.status.warningContainer, MaterialTheme.status.onWarningContainer)
                            }
                        }
                        account.optJSONArray("windows")?.objects()?.forEach { window ->
                            val percent = window.optDouble("used_percent", Double.NaN)
                            val level = quotaLevel(percent)
                            val levelColor = when (level) { QuotaLevel.ERROR -> MaterialTheme.status.error; QuotaLevel.WARNING -> MaterialTheme.status.warning; QuotaLevel.OK -> MaterialTheme.status.success; QuotaLevel.UNKNOWN -> MaterialTheme.colorScheme.outline }
                            val levelText = when (level) { QuotaLevel.ERROR -> stringResource(R.string.quota_level_error); QuotaLevel.WARNING -> stringResource(R.string.quota_level_warning); else -> null }
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("${quotaWindowLabel(window)} · ${if (percent.isFinite()) String.format(androidx.compose.ui.platform.LocalConfiguration.current.locales[0], "%.1f%% used", percent) else "Unavailable"}", Modifier.weight(1f, fill = false))
                                if (levelText != null) Text(levelText, style = MaterialTheme.typography.labelMedium, color = levelColor)
                            }
                            if (percent.isFinite()) LinearProgressIndicator(progress = { (percent / 100).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth(), color = levelColor, trackColor = MaterialTheme.colorScheme.surfaceContainerHighest)
                            quotaTime(window.optString("resets_at"))?.let { Text("Resets $it", style = MaterialTheme.typography.bodySmall) }
                        }
                        quotaTime(account.optString("fetched_at"))?.let { Text("Updated $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
        }
    }
    }
}
