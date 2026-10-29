package io.uggs.orchestrator

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.util.Locale

@Composable internal fun EngineIcon(agent: JSONObject?, modifier: Modifier = Modifier) {
    val engine = agent?.optString("engine").orEmpty().trim()
    val unknownEngine = stringResource(R.string.engine_unknown)
    val (drawable, label) = when (engine.lowercase(Locale.ROOT)) {
        "codex" -> R.drawable.ic_engine_codex to "Codex"
        "claude" -> R.drawable.ic_engine_claude to "Claude"
        "grok" -> R.drawable.ic_engine_grok to "Grok"
        else -> null to engine.ifBlank { unknownEngine }
    }
    val description = stringResource(R.string.engine_description, label)
    if (drawable != null) Icon(painterResource(drawable), description, modifier.size(28.dp), tint = MaterialTheme.colorScheme.onSurface)
    else CompanionIcon(CompanionSymbol.Terminal, description, tint = MaterialTheme.colorScheme.onSurface, modifier = modifier.size(28.dp))
}

@Composable internal fun AgentAvatar(agent: JSONObject?) {
    Surface(Modifier.size(52.dp), shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainer) {
        Box(contentAlignment = Alignment.Center) { EngineIcon(agent) }
    }
}

@Composable internal fun HostBadge(agent: JSONObject?) {
    val host = agentHost(agent) ?: return
    val hostDescription = stringResource(R.string.host_description, host)
    val shortName = if (host.contains(':') || host.all { it.isDigit() || it == '.' }) host else host.substringBefore('.')
    Surface(
        modifier = Modifier.clearAndSetSemantics { contentDescription = hostDescription },
        shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainer,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
    ) {
        Row(Modifier.padding(horizontal = 7.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            CompanionIcon(CompanionSymbol.Computer, modifier = Modifier.size(12.dp))
            Text(shortName, modifier = Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

internal fun roomPresenceLabel(t: Texts, presence: String) = t.string(when (presence) {
    "working" -> R.string.status_working; "listening" -> R.string.status_listening; "idle" -> R.string.status_idle
    "available" -> R.string.status_available; else -> R.string.status_offline
})

/** Engine icon with a presence badge; the state is also spoken and written next to it, never colour alone. */
@Composable internal fun MemberAvatar(member: JSONObject, presence: String, size: Dp = 40.dp) {
    val t = rememberTexts()
    val description = t.string(R.string.label_colon_value, roomPersonLabel(t, member), roomPresenceLabel(t, presence))
    Box(Modifier.size(size).clearAndSetSemantics { contentDescription = description }) {
        Surface(Modifier.fillMaxSize(), shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainer) {
            Box(contentAlignment = Alignment.Center) { EngineIcon(member, Modifier.size(minOf(28.dp, size * .7f))) }
        }
        PresenceDot(presence, Modifier.align(Alignment.BottomEnd).size(minOf(14.dp, size * .35f)))
    }
}
