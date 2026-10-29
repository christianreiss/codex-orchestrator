package io.uggs.orchestrator

import android.text.format.DateFormat
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** Bubble palette, kept local to chat: own bubbles are solid blue with white text, others a raised surface. */
internal data class BubbleColors(val container: Color, val content: Color, val secondary: Color, val markdown: MarkdownColors, val border: BorderStroke?)

@Composable internal fun bubbleColors(own: Boolean, severity: String?): BubbleColors {
    val scheme = MaterialTheme.colorScheme
    val dark = scheme.background.luminance() < .5f
    return when {
        severity != null -> BubbleColors(scheme.errorContainer, scheme.onErrorContainer, scheme.onErrorContainer.copy(alpha = .85f),
            MarkdownColors(scheme.onErrorContainer, scheme.onErrorContainer.copy(alpha = .1f), scheme.error), BorderStroke(1.dp, scheme.error))
        own -> {
            // White on #0063E8 is 5:1, on #2B5BAE 6.6:1 (WCAG AA for body text in both themes).
            val container = if (dark) Color(0xFF2B5BAE) else Color(0xFF0063E8)
            BubbleColors(container, Color.White, Color.White.copy(alpha = .86f),
                MarkdownColors(Color.White, Color.Black.copy(alpha = .2f), Color.White.copy(alpha = .7f)), null)
        }
        else -> BubbleColors(if (dark) scheme.surfaceContainerHigh else scheme.surface, scheme.onSurface, scheme.onSurfaceVariant,
            defaultMarkdownColors(), if (dark) null else BorderStroke(1.dp, scheme.outlineVariant))
    }
}

/**
 * Shared rows of the chat timeline. Bubbles and earlier questions are drawn by
 * the caller, which knows Portal or room specifics; separators, status runs and
 * lifecycle markers look the same everywhere.
 */
internal fun LazyListScope.timelineItems(
    items: List<TimelineItem>,
    expandedRuns: Set<String>,
    toggleRun: (String) -> Unit,
    decision: @Composable (TimelineItem.Decision) -> Unit = {},
    after: @Composable (TimelineItem) -> Unit = {},
    bubble: @Composable (TimelineItem.Bubble) -> Unit,
) {
    items(items, key = { it.key }) { item ->
        Column(Modifier.fillMaxWidth()) {
            when (item) {
                is TimelineItem.Day -> DaySeparator(dayLabel(rememberTexts(), item.date))
                is TimelineItem.StatusRun -> StatusRunRow(item, item.key in expandedRuns) { toggleRun(item.key) }
                is TimelineItem.Lifecycle -> LifecycleRow(item.line)
                is TimelineItem.Decision -> decision(item)
                is TimelineItem.Bubble -> bubble(item)
            }
            after(item)
        }
    }
}

@Composable internal fun DaySeparator(label: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = 14.dp), contentAlignment = Alignment.Center) {
        Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
            Text(label, Modifier.padding(horizontal = 12.dp, vertical = 5.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable private fun clockLabel(time: java.time.Instant?): String? {
    val use24 = DateFormat.is24HourFormat(LocalContext.current)
    val t = rememberTexts()
    return time?.let { timeLabel(t, it, use24) }
}

@Composable internal fun StatusRunRow(run: TimelineItem.StatusRun, expanded: Boolean, toggle: () -> Unit) {
    val summary = pluralStringResource(R.plurals.chat_status_updates, run.lines.size, run.lines.size)
    val time = clockLabel(run.lines.lastOrNull()?.time)
    val state = stringResource(if (expanded) R.string.chat_expanded else R.string.chat_collapsed)
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (expanded) run.lines.forEach { line ->
            Text(line.text, Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 1.dp), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                fontFamily = if (line.monospace) FontFamily.Monospace else null)
        }
        Row(
            Modifier.heightIn(min = 48.dp).clip(RoundedCornerShape(24.dp)).clickable(role = Role.Button, onClick = toggle)
                .semantics { stateDescription = state }.padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text("⋯", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(if (expanded) stringResource(R.string.chat_hide_updates) else listOfNotNull(summary, time).joinToString(" · "),
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable internal fun LifecycleRow(line: StatusLine) {
    val color = when (line.tone) {
        StatusLine.Tone.Failure -> MaterialTheme.colorScheme.error
        StatusLine.Tone.Success -> Color(0xFF2E7D4F).takeIf { MaterialTheme.colorScheme.background.luminance() > .5f } ?: Color(0xFF7BD29A)
        StatusLine.Tone.Neutral -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
        Text(listOfNotNull(line.text, clockLabel(line.time)).joinToString(" · "), Modifier.widthIn(max = 260.dp), style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Medium, color = color, textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis)
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/**
 * Drag a bubble towards the middle past the threshold to reply (others' bubbles
 * to the right, own bubbles to the left); one haptic tick marks the threshold.
 */
@Composable internal fun SwipeToReply(enabled: Boolean, onReply: () -> Unit, reverse: Boolean = false, content: @Composable () -> Unit) {
    if (!enabled) { content(); return }
    val haptic = LocalHapticFeedback.current
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val threshold = with(LocalDensity.current) { 64.dp.toPx() }
    val reply by rememberUpdatedState(onReply)
    var armed by remember { mutableStateOf(false) }
    val sign = if (reverse) -1f else 1f
    Box(contentAlignment = if (reverse) Alignment.CenterEnd else Alignment.CenterStart) {
        val pulled = offset.value * sign
        if (pulled > 4f) CompanionIcon(CompanionSymbol.Reply, tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(horizontal = 8.dp).alpha((pulled / threshold).coerceIn(0f, 1f)))
        Box(Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }.pointerInput(Unit) {
            detectHorizontalDragGestures(
                onDragEnd = { if (armed) reply(); armed = false; scope.launch { offset.animateTo(0f) } },
                onDragCancel = { armed = false; scope.launch { offset.animateTo(0f) } },
            ) { change, amount ->
                val pulled = ((offset.value + amount) * sign).coerceIn(0f, threshold * 1.3f)
                scope.launch { offset.snapTo(pulled * sign) }
                if (!armed && pulled >= threshold) { armed = true; haptic.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate) }
                else if (armed && pulled < threshold) armed = false
                change.consume()
            }
        }) { content() }
    }
}

/** One menu entry of the long-press menu, also exposed as an accessibility action. */
internal data class BubbleAction(val label: String, val icon: CompanionSymbol? = null, val run: () -> Unit)

/**
 * The bubble frame shared by direct chats and rooms: alignment, grouping shape,
 * author line and avatar at a group start, the long-press menu and swipe to reply.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable internal fun ChatBubble(
    item: TimelineItem.Bubble,
    tag: String,
    colors: BubbleColors,
    actions: List<BubbleAction>,
    onReply: (() -> Unit)?,
    highlighted: Boolean = false,
    author: String? = null,
    avatar: (@Composable () -> Unit)? = null,
    /** Drawn under the bubble (reaction chips), outside its surface. */
    below: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val own = item.own
    val shape = RoundedCornerShape(
        topStart = if (!own && item.startsGroup) 4.dp else 16.dp,
        topEnd = if (own && item.startsGroup) 4.dp else 16.dp,
        bottomEnd = 16.dp, bottomStart = 16.dp,
    )
    var menu by remember(item.key) { mutableStateOf(false) }
    val actionsLabel = stringResource(R.string.chat_message_actions)
    BoxWithConstraints(Modifier.fillMaxWidth().padding(top = if (item.startsGroup) 10.dp else 2.dp)) {
        val avatarSlot = 36.dp
        val bubbleWidth = maxWidth * .86f - if (avatar != null) avatarSlot else 0.dp
        Row(Modifier.fillMaxWidth(), horizontalArrangement = if (own) Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Top) {
            if (avatar != null && !own) Box(Modifier.width(avatarSlot).padding(top = if (author != null) 18.dp else 0.dp)) { if (item.startsGroup) avatar() }
            Column(horizontalAlignment = if (own) Alignment.End else Alignment.Start) {
                if (author != null && item.startsGroup) Text(author, Modifier.padding(horizontal = 10.dp, vertical = 2.dp).widthIn(max = bubbleWidth),
                    style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                SwipeToReply(onReply != null, { onReply?.invoke() }, reverse = own) {
                    Box(Modifier.widthIn(max = bubbleWidth)) {
                        Surface(
                            modifier = Modifier.testTag(tag)
                                .combinedClickable(onClick = {}, onLongClickLabel = actionsLabel, onLongClick = { if (actions.isNotEmpty()) menu = true })
                                .semantics { customActions = actions.map { action -> CustomAccessibilityAction(action.label) { action.run(); true } } },
                            shape = shape, color = colors.container, contentColor = colors.content,
                            border = if (highlighted) BorderStroke(2.dp, MaterialTheme.colorScheme.tertiary) else colors.border,
                        ) { Column(Modifier.padding(4.dp), verticalArrangement = Arrangement.spacedBy(3.dp), content = content) }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            actions.forEach { action ->
                                DropdownMenuItem(text = { Text(action.label) }, onClick = { menu = false; action.run() },
                                    leadingIcon = action.icon?.let { icon -> { CompanionIcon(icon) } })
                            }
                        }
                    }
                }
                below?.invoke(this)
            }
        }
    }
}

/** Time and delivery line at the end of a bubble; the time only closes a group. */
@Composable internal fun ColumnScope.BubbleFooter(item: TimelineItem.Bubble, colors: BubbleColors, extra: @Composable RowScope.() -> Unit = {}) {
    val time = if (item.endsGroup) clockLabel(item.message.createdAt) else null
    Row(Modifier.align(Alignment.End).padding(horizontal = 6.dp, vertical = 1.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        extra()
        if (time != null) Text(time, style = MaterialTheme.typography.labelSmall, color = colors.secondary)
    }
}

@Composable internal fun ReplyQuote(preview: ReplyPreview, modifier: Modifier = Modifier, accent: Color = MaterialTheme.colorScheme.primary, onClick: (() -> Unit)? = null) {
    val label = stringResource(R.string.chat_show_quoted)
    Surface(modifier.then(if (onClick != null) Modifier.clickable(onClickLabel = label, onClick = onClick) else Modifier), shape = RoundedCornerShape(8.dp), color = accent.copy(alpha = .12f)) {
        Row(Modifier.height(IntrinsicSize.Min)) {
            Spacer(Modifier.width(4.dp).fillMaxHeight().background(accent))
            Column(Modifier.padding(horizontal = 10.dp, vertical = 7.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(preview.author, style = MaterialTheme.typography.labelMedium, color = accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (preview.text.isNotBlank()) Text(preview.text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** Message text, selectable on request. Long press opens the menu, so selection is an explicit mode. */
@Composable internal fun BubbleText(text: String, markdown: Boolean, colors: BubbleColors, selecting: Boolean, stopSelecting: () -> Unit) {
    val body: @Composable () -> Unit = {
        if (markdown) ChatMarkdown(text, Modifier.padding(horizontal = 8.dp, vertical = 4.dp), colors.markdown)
        else Text(text, Modifier.padding(horizontal = 8.dp, vertical = 4.dp), style = MaterialTheme.typography.bodyLarge)
    }
    if (!selecting) body()
    else Column {
        androidx.compose.foundation.text.selection.SelectionContainer { body() }
        TextButton(onClick = stopSelecting, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.chat_done_selecting), color = colors.content) }
    }
}

/** Three pulsing dots while the agent works; the label is spoken, the animation is decoration. */
@Composable internal fun TypingIndicator(label: String, avatar: (@Composable () -> Unit)? = null) {
    val transition = rememberInfiniteTransition(label = "typing")
    val phase by transition.animateFloat(0f, 3f, infiniteRepeatable(tween(1200), RepeatMode.Restart), label = "typing-phase")
    Row(Modifier.fillMaxWidth().padding(top = 8.dp).semantics(mergeDescendants = true) { contentDescription = label }.testTag("typing-indicator"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (avatar != null) Box(Modifier.width(30.dp).clearAndSetSemantics { }) { avatar() }
        Surface(shape = RoundedCornerShape(16.dp), color = bubbleColors(false, null).container, border = bubbleColors(false, null).border) {
            Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                repeat(3) { dot ->
                    val active = phase.toInt() == dot
                    Box(Modifier.size(7.dp).alpha(if (active) 1f else .35f).background(MaterialTheme.colorScheme.onSurfaceVariant, CircleShape))
                }
            }
        }
    }
}

/** Keeps the established "New messages" label; the count sits in a badge next to it. */
@Composable internal fun NewMessagesPill(count: Int?, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val description = count?.let { pluralStringResource(R.plurals.chat_new_count, it, it) }
    FilledTonalButton(onClick = onClick, modifier = modifier.heightIn(min = 48.dp).then(if (description != null) Modifier.semantics { stateDescription = description } else Modifier),
        elevation = ButtonDefaults.filledTonalButtonElevation(defaultElevation = 3.dp)) {
        CompanionIcon(CompanionSymbol.Down)
        Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.chat_new_messages))
        if (count != null && count > 0) {
            Spacer(Modifier.width(8.dp))
            Badge(containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary) { Text(if (count > 99) "99+" else count.toString()) }
        }
    }
}
