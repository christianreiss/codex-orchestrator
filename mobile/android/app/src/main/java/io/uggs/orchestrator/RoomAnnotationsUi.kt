package io.uggs.orchestrator

import android.text.format.DateFormat
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant

/** Reaction chips under a room bubble: emoji and count, outlined and filled when this operator reacted. A tap toggles. */
@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun ReactionChips(tagPrefix: String, reactions: List<RoomReaction>, enabled: Boolean, toggle: (String) -> Unit) {
    if (reactions.isEmpty()) return
    val scheme = MaterialTheme.colorScheme
    val mineText = stringResource(R.string.reaction_mine)
    FlowRow(Modifier.padding(horizontal = 2.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        reactions.forEach { reaction ->
            val description = pluralStringResource(R.plurals.reaction_chip_cd, reaction.count, reaction.emoji, reaction.count)
            Box(
                Modifier.minimumInteractiveComponentSize().testTag("$tagPrefix:${reaction.emoji}")
                    .then(if (enabled) Modifier.clickable(role = Role.Button) { toggle(reaction.emoji) } else Modifier)
                    .semantics(mergeDescendants = true) { contentDescription = description; if (reaction.mine) stateDescription = mineText },
                contentAlignment = Alignment.Center,
            ) {
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = if (reaction.mine) scheme.primaryContainer else scheme.surfaceContainerHigh,
                    contentColor = if (reaction.mine) scheme.onPrimaryContainer else scheme.onSurface,
                    border = BorderStroke(if (reaction.mine) 2.dp else 1.dp, if (reaction.mine) scheme.primary else scheme.outlineVariant),
                ) {
                    Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(reaction.emoji, style = MaterialTheme.typography.bodyMedium)
                        Text(reaction.count.toString(), style = MaterialTheme.typography.labelLarge, fontWeight = if (reaction.mine) FontWeight.Bold else FontWeight.Medium)
                    }
                }
            }
        }
    }
}

/** The small emoji picker behind the long-press "React" action; emoji this operator already used are marked. */
@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun ReactionPicker(selected: Set<String>, pick: (String) -> Unit, dismiss: () -> Unit) {
    val chosen = stringResource(R.string.reaction_mine)
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text(stringResource(R.string.reaction_picker_title)) },
        text = {
            FlowRow(Modifier.testTag("reaction-picker"), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                QUICK_REACTIONS.forEach { emoji ->
                    val mine = emoji in selected
                    val label = stringResource(R.string.reaction_picker_item, emoji)
                    Surface(
                        modifier = Modifier.size(48.dp).testTag("reaction-pick:$emoji").semantics(mergeDescendants = true) { contentDescription = label; if (mine) stateDescription = chosen },
                        shape = RoundedCornerShape(12.dp), color = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
                        border = if (mine) BorderStroke(2.dp, MaterialTheme.colorScheme.primary) else null,
                        onClick = { pick(emoji) },
                    ) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(emoji, fontSize = 24.sp) } }
                }
            }
        },
        confirmButton = { TextButton(onClick = dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.pins_close)) } },
    )
}

/** Latest pin and the pin count at the top of a room; opens the pin list. */
@Composable internal fun PinnedStrip(count: Int, snippet: String?, open: () -> Unit) {
    val openLabel = stringResource(R.string.pins_strip_open)
    Surface(Modifier.fillMaxWidth().testTag("room-pinned-strip").clickable(role = Role.Button, onClickLabel = openLabel, onClick = open), color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(Modifier.heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.pins_strip_label), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
            Text(snippet.orEmpty().replace('\n', ' '), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(pluralStringResource(R.plurals.pins_strip_count, count, count), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** The pin list of a room. "Show in conversation" jumps to a loaded event; Unpin needs write access. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun PinsSheet(pinned: List<String>, entries: List<RoomPin>, loaded: Boolean, canUnpin: Boolean, show: (String) -> Unit, unpin: (String) -> Unit, dismiss: () -> Unit) {
    val t = rememberTexts()
    val use24 = DateFormat.is24HourFormat(LocalContext.current)
    // Entries follow the live pin list, so an unpin disappears at once.
    val visible = entries.filter { it.eventId in pinned }
    ModalBottomSheet(onDismissRequest = dismiss, shape = SheetShape, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Text(stringResource(R.string.pins_sheet_title), Modifier.padding(horizontal = 24.dp, vertical = 8.dp), style = MaterialTheme.typography.titleLarge)
        if (!loaded) LinearProgressIndicator(Modifier.fillMaxWidth())
        else if (visible.isEmpty()) Text(stringResource(R.string.pins_empty), Modifier.padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        LazyColumn(Modifier.testTag("room-pins-list"), contentPadding = PaddingValues(bottom = 24.dp)) {
            items(visible, key = { it.eventId }) { pin ->
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    val time = pin.createdAt?.let { runCatching { Instant.parse(it) }.getOrNull() }?.let { timeLabel(t, it, use24) }
                    val meta = listOfNotNull(pin.author, time).joinToString(" · ")
                    if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(pin.snippet?.takeIf { it.isNotBlank() } ?: stringResource(R.string.pins_unavailable), maxLines = 4, overflow = TextOverflow.Ellipsis)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (pin.snippet != null) TextButton(onClick = { show(pin.eventId) }, modifier = Modifier.heightIn(min = 48.dp).testTag("room-pin-show:${pin.eventId}")) { Text(stringResource(R.string.pins_show)) }
                        if (canUnpin) TextButton(onClick = { unpin(pin.eventId) }, modifier = Modifier.heightIn(min = 48.dp).testTag("room-pin-unpin:${pin.eventId}")) { Text(stringResource(R.string.pins_unpin)) }
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}
