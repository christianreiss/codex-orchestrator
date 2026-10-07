package io.uggs.orchestrator

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.util.Locale

@Composable internal fun EngineIcon(agent: JSONObject?, modifier: Modifier = Modifier) {
    val engine = agent?.optString("engine").orEmpty().trim()
    val (drawable, label) = when (engine.lowercase(Locale.ROOT)) {
        "codex" -> R.drawable.ic_engine_codex to "Codex"
        "claude" -> R.drawable.ic_engine_claude to "Claude"
        "grok" -> R.drawable.ic_engine_grok to "Grok"
        else -> null to engine.ifBlank { "Unknown engine" }
    }
    if (drawable != null) Icon(painterResource(drawable), "Engine: $label", modifier.size(28.dp), tint = MaterialTheme.colorScheme.onSurface)
    else CompanionIcon(CompanionSymbol.Terminal, "Engine: $label", tint = MaterialTheme.colorScheme.onSurface, modifier = modifier.size(28.dp))
}

@Composable internal fun AgentAvatar(agent: JSONObject?) {
    Surface(Modifier.size(46.dp), shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainer) {
        Box(contentAlignment = Alignment.Center) { EngineIcon(agent) }
    }
}

@Composable internal fun HostBadge(agent: JSONObject?) {
    val host = agentHost(agent) ?: return
    val shortName = if (host.contains(':') || host.all { it.isDigit() || it == '.' }) host else host.substringBefore('.')
    Surface(
        modifier = Modifier.clearAndSetSemantics { contentDescription = "Host: $host" },
        shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainer,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
    ) {
        Row(Modifier.padding(horizontal = 7.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            CompanionIcon(CompanionSymbol.Computer, modifier = Modifier.size(12.dp))
            Text(shortName, modifier = Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
