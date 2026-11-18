package io.uggs.orchestrator

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.animation.core.animateFloat
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.runtime.getValue
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Brand primary: one calm, saturated blue shared by light and dark accents. */
internal val MessageBlue = Color(0xFF2D5BE3)

private val LightColors = lightColorScheme(
    primary = MessageBlue, onPrimary = Color.White,
    primaryContainer = Color(0xFFDDE6FF), onPrimaryContainer = Color(0xFF0E2A6E),
    secondary = Color(0xFF586174), onSecondary = Color.White,
    secondaryContainer = Color(0xFFE6EAF2), onSecondaryContainer = Color(0xFF1F2838),
    tertiary = Color(0xFF6A4FC8), onTertiary = Color.White,
    tertiaryContainer = Color(0xFFEAE3FF), onTertiaryContainer = Color(0xFF26145E),
    background = Color(0xFFF7F8FA), onBackground = Color(0xFF141821),
    surface = Color(0xFFF7F8FA), onSurface = Color(0xFF141821),
    surfaceVariant = Color(0xFFE6E9EF), onSurfaceVariant = Color(0xFF5A6070),
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFFFFFFF),
    surfaceContainer = Color(0xFFEFF1F5), surfaceContainerHigh = Color(0xFFE8EBF0),
    surfaceContainerHighest = Color(0xFFE1E5EC),
    outline = Color(0xFF8A90A0), outlineVariant = Color(0xFFE1E4EA),
    error = Color(0xFFBA1A1A), onError = Color.White, errorContainer = Color(0xFFFFDAD6), onErrorContainer = Color(0xFF410002),
)
private val DarkColors = darkColorScheme(
    primary = Color(0xFF9DB6FF), onPrimary = Color(0xFF00257A),
    primaryContainer = Color(0xFF1F3F9E), onPrimaryContainer = Color(0xFFDDE6FF),
    secondary = Color(0xFFBFC6D6), onSecondary = Color(0xFF29303F),
    secondaryContainer = Color(0xFF2A303C), onSecondaryContainer = Color(0xFFDDE3F0),
    tertiary = Color(0xFFCBBEFF), onTertiary = Color(0xFF341F7A),
    tertiaryContainer = Color(0xFF4B3599), onTertiaryContainer = Color(0xFFEAE3FF),
    background = Color(0xFF0F1115), onBackground = Color(0xFFE6E8EE),
    surface = Color(0xFF0F1115), onSurface = Color(0xFFE6E8EE),
    surfaceVariant = Color(0xFF2B303A), onSurfaceVariant = Color(0xFFA9AFBD),
    surfaceContainerLowest = Color(0xFF0A0C0F), surfaceContainerLow = Color(0xFF15181D),
    surfaceContainer = Color(0xFF1A1E24), surfaceContainerHigh = Color(0xFF22262E),
    surfaceContainerHighest = Color(0xFF2B303A),
    outline = Color(0xFF7D8494), outlineVariant = Color(0xFF2E333D),
    error = Color(0xFFFFB4AB), onError = Color(0xFF690005), errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
)
private val CompanionTypography = Typography(
    headlineLarge = TextStyle(fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.6).sp),
    headlineSmall = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp),
    titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 15.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.4.sp),
)

/** Spacing scale; screens use these instead of ad-hoc paddings. */
internal object Space {
    val xs = 4.dp; val s = 8.dp; val m = 12.dp; val l = 16.dp; val xl = 24.dp
}

/** Semantic status colors that the Material scheme lacks; always paired with text or an icon, never color alone. */
@Immutable internal data class StatusColors(
    val success: Color, val onSuccess: Color, val successContainer: Color, val onSuccessContainer: Color,
    val warning: Color, val onWarning: Color, val warningContainer: Color, val onWarningContainer: Color,
    val error: Color, val onError: Color, val errorContainer: Color, val onErrorContainer: Color,
    val info: Color, val onInfo: Color, val infoContainer: Color, val onInfoContainer: Color,
)
internal val LightStatusColors = StatusColors(
    success = Color(0xFF1E7D45), onSuccess = Color.White, successContainer = Color(0xFFDDF3E4), onSuccessContainer = Color(0xFF0B3D20),
    warning = Color(0xFF8A5A00), onWarning = Color.White, warningContainer = Color(0xFFFFEFCC), onWarningContainer = Color(0xFF4A3000),
    error = Color(0xFFB3261E), onError = Color.White, errorContainer = Color(0xFFF9DEDC), onErrorContainer = Color(0xFF410E0B),
    info = Color(0xFF2D5BE3), onInfo = Color.White, infoContainer = Color(0xFFDDE6FF), onInfoContainer = Color(0xFF0E2A6E),
)
internal val DarkStatusColors = StatusColors(
    success = Color(0xFF7FD8A0), onSuccess = Color(0xFF00391B), successContainer = Color(0xFF12361F), onSuccessContainer = Color(0xFFC4EFD3),
    warning = Color(0xFFFFC857), onWarning = Color(0xFF3F2A00), warningContainer = Color(0xFF3F2E0A), onWarningContainer = Color(0xFFFFE3A8),
    error = Color(0xFFFFB4AB), onError = Color(0xFF690005), errorContainer = Color(0xFF5A1A17), onErrorContainer = Color(0xFFFFDAD6),
    info = Color(0xFF9DB6FF), onInfo = Color(0xFF00257A), infoContainer = Color(0xFF1F3F9E), onInfoContainer = Color(0xFFDDE6FF),
)
internal val LocalStatusColors = staticCompositionLocalOf { LightStatusColors }
internal val MaterialTheme.status: StatusColors @Composable @ReadOnlyComposable get() = LocalStatusColors.current

@Composable fun CompanionTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalStatusColors provides if (dark) DarkStatusColors else LightStatusColors) { MaterialTheme(
        // A fixed brand palette on every Android version: status colours are tuned against it.
        colorScheme = if (dark) DarkColors else LightColors,
        typography = CompanionTypography,
        shapes = Shapes(
            extraSmall = RoundedCornerShape(6.dp), small = RoundedCornerShape(10.dp),
            medium = RoundedCornerShape(14.dp), large = RoundedCornerShape(20.dp), extraLarge = RoundedCornerShape(28.dp),
        ), content = content,
    ) }
}

// Shared building blocks so Chats, Hosts, Authorizations and the sheets read as one app.
internal val SheetShape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)

@Composable internal fun searchFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
    focusedBorderColor = MaterialTheme.colorScheme.primary,
    unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
)

/** Borderless filled pill used by every search field. */
@Composable internal fun pillFieldColors() = TextFieldDefaults.colors(
    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh, unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
)

@Composable internal fun companionCardColors() = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
@Composable internal fun companionCardBorder() = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)

/** Small section heading with an optional count, used above grouped lists. */
@Composable internal fun SectionHeader(title: String, count: Int? = null, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
        if (count != null && count > 0) Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
            Text(count.toString(), Modifier.padding(horizontal = 9.dp, vertical = 2.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onPrimaryContainer)
        }
    }
}

/** Centered empty or waiting state shared by every list. */
@Composable internal fun EmptyState(title: String, detail: String? = null, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        if (detail != null) Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

/** A quiet status dot: true is healthy, false is unavailable. */
@Composable internal fun StatusDot(ok: Boolean, modifier: Modifier = Modifier) {
    Box(modifier.size(10.dp).background(if (ok) MaterialTheme.status.success else MaterialTheme.colorScheme.outline, CircleShape))
}

/** Slim status chip (icon-free, text carries the meaning) in a status container. */
@Composable internal fun StatusChip(text: String, container: Color, content: Color, modifier: Modifier = Modifier) {
    Surface(modifier, shape = CircleShape, color = container, contentColor = content) {
        Text(text, Modifier.padding(horizontal = 10.dp, vertical = 3.dp), style = MaterialTheme.typography.labelMedium)
    }
}

/** Placeholder block for first-load skeletons; pulses subtly. */
@Composable internal fun SkeletonBlock(modifier: Modifier = Modifier) {
    val transition = androidx.compose.animation.core.rememberInfiniteTransition(label = "skeleton")
    val alpha by transition.animateFloat(0.35f, 0.8f, androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(900), androidx.compose.animation.core.RepeatMode.Reverse), label = "alpha")
    Box(modifier.background(MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = alpha), MaterialTheme.shapes.small))
}

/** Card-shaped skeleton list shown while the first snapshot loads. */
@Composable internal fun SkeletonCards(count: Int = 3, modifier: Modifier = Modifier) {
    val loading = androidx.compose.ui.res.stringResource(R.string.loading)
    Column(modifier.fillMaxWidth().semantics { contentDescription = loading }, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        repeat(count) {
            Card(Modifier.fillMaxWidth(), colors = companionCardColors(), border = companionCardBorder()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SkeletonBlock(Modifier.fillMaxWidth(0.55f).height(16.dp))
                    SkeletonBlock(Modifier.fillMaxWidth(0.85f).height(12.dp))
                    SkeletonBlock(Modifier.fillMaxWidth(0.4f).height(12.dp))
                }
            }
        }
    }
}

/**
 * The six states an agent, host or message can be in, as one vocabulary. Each role has a colour **and** a
 * glyph, so state never rests on colour alone (docs/android-design.md).
 */
internal enum class StatusRole { Ready, Working, Waiting, Attention, Error, Offline }

@Composable @ReadOnlyComposable internal fun StatusRole.color(): Color = when (this) {
    StatusRole.Ready -> MaterialTheme.status.success
    StatusRole.Working -> MaterialTheme.status.warning
    StatusRole.Waiting -> MaterialTheme.colorScheme.tertiary
    StatusRole.Attention -> MaterialTheme.colorScheme.primary
    StatusRole.Error -> MaterialTheme.colorScheme.error
    StatusRole.Offline -> MaterialTheme.colorScheme.outline
}
