package io.uggs.orchestrator

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.pow

private fun initialsSource(name: String): String = name.filter { it.isLetterOrDigit() }.ifEmpty { "?" }

private fun formatInitials(prefix: String) = prefix.lowercase().replaceFirstChar { it.uppercaseChar() }

/**
 * Initials for each member: the shortest prefix of the member's name (1–3
 * letters or digits) that no other member's name starts with. Identical names
 * keep three letters; the colour still tells them apart.
 */
internal fun memberInitials(names: Map<String, String>): Map<String, String> {
    val sources = names.mapValues { initialsSource(it.value).lowercase() }
    return sources.mapValues { (id, source) ->
        val others = sources.filterKeys { it != id }.values
        val length = (1..3).firstOrNull { length -> source.length >= length && others.none { it.startsWith(source.take(length)) } } ?: 3
        formatInitials(source.take(length))
    }
}

/**
 * Initials stay fixed for a room once shown: a member joining later must not
 * re-letter people the operator has already learned to recognise. New members
 * get the shortest prefix that is unique among everyone and unused.
 */
internal fun freezeInitials(previous: Map<String, String>, names: Map<String, String>): Map<String, String> {
    val kept = previous.filterKeys { it in names }
    val fresh = memberInitials(names)
    val used = kept.values.map { it.lowercase() }.toMutableSet()
    val result = LinkedHashMap(kept)
    names.keys.filter { it !in kept }.forEach { id ->
        val source = initialsSource(names.getValue(id)).lowercase()
        val candidate = fresh.getValue(id).lowercase()
        val choice = (candidate.length..3).map { source.take(it) }.distinct().firstOrNull { it !in used } ?: candidate
        used += choice
        result[id] = formatInitials(choice)
    }
    return result
}

private fun channel(value: Int): Double = (value / 255.0).let { if (it <= 0.03928) it / 12.92 else ((it + 0.055) / 1.055).pow(2.4) }

internal fun relativeLuminance(argb: Int): Double =
    0.2126 * channel(argb shr 16 and 0xFF) + 0.7152 * channel(argb shr 8 and 0xFF) + 0.0722 * channel(argb and 0xFF)

internal fun contrastRatio(first: Int, second: Int): Double {
    val a = relativeLuminance(first); val b = relativeLuminance(second)
    return (maxOf(a, b) + 0.05) / (minOf(a, b) + 0.05)
}

private fun hslToArgb(hue: Double, saturation: Double, lightness: Double): Int {
    val c = (1 - abs(2 * lightness - 1)) * saturation
    val x = c * (1 - abs((hue / 60) % 2 - 1))
    val m = lightness - c / 2
    val (r, g, b) = when {
        hue < 60 -> Triple(c, x, 0.0); hue < 120 -> Triple(x, c, 0.0); hue < 180 -> Triple(0.0, c, x)
        hue < 240 -> Triple(0.0, x, c); hue < 300 -> Triple(x, 0.0, c); else -> Triple(c, 0.0, x)
    }
    fun byte(v: Double) = ((v + m) * 255).toInt().coerceIn(0, 255)
    return (0xFF shl 24) or (byte(r) shl 16) or (byte(g) shl 8) or byte(b)
}

/** A stable colour per agent: hue from the UUID, darkened until white initials reach WCAG AA (4.5:1). */
internal fun avatarColorArgb(id: String): Int {
    var hash = 0x811C9DC5.toInt()
    id.lowercase().forEach { hash = (hash xor it.code) * 0x01000193 }
    val hue = ((hash.toLong() and 0xFFFFFFFFL) % 360).toDouble()
    var lightness = 0.45
    var color = hslToArgb(hue, 0.55, lightness)
    while (contrastRatio(color, 0xFFFFFFFF.toInt()) < 4.5 && lightness > 0.1) {
        lightness -= 0.02
        color = hslToArgb(hue, 0.55, lightness)
    }
    return color
}

/** The member's agent UUID when known, so colour follows the agent rather than the roster row. */
internal fun avatarIdentity(member: JSONObject): String =
    member.optString("session_id").takeIf { it.isNotBlank() && it != "null" } ?: member.optString("id")

/**
 * Initials avatar for rooms with several members, with a small engine badge and,
 * when [presence] is given, the presence dot. The spoken description carries
 * name and state, so neither colour nor the dot is the only signal.
 */
@Composable internal fun GroupAvatar(member: JSONObject, initials: String, presence: String?, size: Dp = 40.dp, engineBadge: Boolean = true) {
    val description = roomPersonLabel(member) + (presence?.let { ": " + roomPresenceLabel(it) } ?: "")
    val ring = MaterialTheme.colorScheme.surface
    Box(Modifier.size(size).clearAndSetSemantics { contentDescription = description }) {
        Box(Modifier.fillMaxSize().background(Color(avatarColorArgb(avatarIdentity(member))), CircleShape), contentAlignment = Alignment.Center) {
            Text(initials, color = Color.White, fontWeight = FontWeight.SemiBold, maxLines = 1,
                fontSize = (size.value * if (initials.length > 2) .30f else .38f).sp)
        }
        if (engineBadge && size >= 28.dp) Surface(Modifier.align(Alignment.TopEnd).size(size * .42f), shape = CircleShape, color = ring) {
            Box(Modifier.padding(1.5.dp), contentAlignment = Alignment.Center) { EngineIcon(member, Modifier.fillMaxSize()) }
        }
        if (presence != null) PresenceDot(presence, Modifier.align(Alignment.BottomEnd).size(size * .35f))
    }
}

@Composable internal fun PresenceDot(presence: String, modifier: Modifier) {
    val dot = modifier.background(MaterialTheme.colorScheme.surface, CircleShape).padding(2.dp)
    when (presence) {
        "working" -> Box(dot.background(Color(0xFFE0A100), CircleShape))
        "listening", "available" -> Box(dot.background(Color(0xFF2E9E5B), CircleShape))
        "idle" -> Box(dot.background(MaterialTheme.colorScheme.primary, CircleShape))
        else -> Box(dot.border(1.5.dp, MaterialTheme.colorScheme.outline, CircleShape))
    }
}

/** A member avatar that picks initials when the room has several members and the engine icon otherwise. */
@Composable internal fun RoomMemberAvatar(member: JSONObject, initials: Map<String, String>, presence: String?, size: Dp = 40.dp, memberCount: Int) {
    val letters = initials[member.optString("id")]
    if (memberCount > 1 && letters != null) GroupAvatar(member, letters, presence, size)
    else MemberAvatar(member, presence ?: "offline", size)
}
