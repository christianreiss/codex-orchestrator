package io.uggs.orchestrator

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal val MessageBlue = Color(0xFF0063E8)

private val LightColors = lightColorScheme(
    primary = MessageBlue, onPrimary = Color.White,
    primaryContainer = Color(0xFFE8F0FF), onPrimaryContainer = Color(0xFF173A72),
    secondary = Color(0xFF536279), secondaryContainer = Color(0xFFEDF2FB), onSecondaryContainer = Color(0xFF253750),
    background = Color(0xFFF5F5F8), onBackground = Color(0xFF17191F),
    surface = Color.White, onSurface = Color(0xFF17191F),
    surfaceContainer = Color(0xFFF0F0F5), surfaceContainerHigh = Color(0xFFE9E9EF),
    surfaceContainerLow = Color.White, surfaceContainerHighest = Color(0xFFE2E4EB),
    onSurfaceVariant = Color(0xFF60636E), outline = Color(0xFF747782), outlineVariant = Color(0xFFE3E4EA),
)
private val DarkColors = darkColorScheme(
    primary = Color(0xFF9EC5FF), onPrimary = Color(0xFF102D55),
    primaryContainer = Color(0xFF192E4C), onPrimaryContainer = Color(0xFFD4E4FF),
    secondary = Color(0xFFB9C7DC), secondaryContainer = Color(0xFF242F41), onSecondaryContainer = Color(0xFFDCE7F8),
    background = Color(0xFF101115), onBackground = Color(0xFFF1F2F6),
    surface = Color(0xFF1A1B21), onSurface = Color(0xFFF1F2F6),
    surfaceContainer = Color(0xFF202127), surfaceContainerHigh = Color(0xFF2A2B33),
    surfaceContainerLow = Color(0xFF191A20), surfaceContainerHighest = Color(0xFF343640),
    onSurfaceVariant = Color(0xFFB0B3C0), outline = Color(0xFF8E929F), outlineVariant = Color(0xFF343640),
)
// Pairing, conversations, hosts and approvals share the same visual language.
@Composable internal fun CompanionHomeTheme(enabled: Boolean, content: @Composable () -> Unit) {
    content()
}
private val CompanionTypography = Typography(
    headlineLarge = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.7).sp),
    headlineSmall = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 21.sp, lineHeight = 27.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 17.sp, fontWeight = FontWeight.Medium),
)

@Composable fun CompanionTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (dark) DarkColors else LightColors,
        typography = CompanionTypography,
        shapes = Shapes(
            extraSmall = RoundedCornerShape(4.dp), small = RoundedCornerShape(8.dp),
            medium = RoundedCornerShape(12.dp), large = RoundedCornerShape(16.dp), extraLarge = RoundedCornerShape(20.dp),
        ), content = content,
    )
}

// Shared building blocks so Chats, Hosts, Authorizations and the sheets read as one app.
internal val SheetShape = RoundedCornerShape(topStart = 30.dp, topEnd = 30.dp)

@Composable internal fun searchFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
    focusedBorderColor = MaterialTheme.colorScheme.primary,
    unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
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
    Box(modifier.size(10.dp).background(if (ok) Color(0xFF2E9E5B) else MaterialTheme.colorScheme.outline, CircleShape))
}
