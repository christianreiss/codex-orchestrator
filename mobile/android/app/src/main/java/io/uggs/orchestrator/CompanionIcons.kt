package io.uggs.orchestrator

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

internal enum class CompanionSymbol { Back, Forward, Up, Down, More, MoreVertical, Search, Chat, Shield, Close, Check, Scan, Computer, Terminal }

/** Small local vector icons; no font, image downloads, or icon library required. */
@Composable internal fun CompanionIcon(symbol: CompanionSymbol, description: String? = null, tint: Color = LocalContentColor.current, modifier: Modifier = Modifier) {
    Canvas(modifier.size(24.dp).then(if (description == null) Modifier else Modifier.semantics { contentDescription = description })) {
        scale(size.width / 24f, size.height / 24f, pivot = Offset.Zero) {
            val stroke = Stroke(1.9f, cap = StrokeCap.Round, join = StrokeJoin.Round)
            fun line(vararg points: Float) {
                val path = Path().apply {
                    moveTo(points[0], points[1])
                    for (i in 2 until points.size step 2) lineTo(points[i], points[i + 1])
                }
                drawPath(path, tint, style = stroke)
            }
            when (symbol) {
                CompanionSymbol.Back -> line(15f, 5f, 8f, 12f, 15f, 19f)
                CompanionSymbol.Forward -> line(9f, 5f, 16f, 12f, 9f, 19f)
                CompanionSymbol.Up -> { line(6f, 11f, 12f, 5f, 18f, 11f); line(12f, 5f, 12f, 19f) }
                CompanionSymbol.Down -> { line(6f, 13f, 12f, 19f, 18f, 13f); line(12f, 5f, 12f, 19f) }
                CompanionSymbol.Close -> { line(6f, 6f, 18f, 18f); line(18f, 6f, 6f, 18f) }
                CompanionSymbol.Check -> line(5f, 12f, 10f, 17f, 19f, 7f)
                CompanionSymbol.Computer -> { line(3f, 4f, 21f, 4f, 21f, 16f, 3f, 16f, 3f, 4f); line(12f, 16f, 12f, 20f); line(8f, 20f, 16f, 20f) }
                CompanionSymbol.Terminal -> { line(3f, 5f, 21f, 5f, 21f, 19f, 3f, 19f, 3f, 5f); line(7f, 9f, 10f, 12f, 7f, 15f); line(13f, 15f, 17f, 15f) }
                CompanionSymbol.More -> listOf(5f, 12f, 19f).forEach { drawCircle(tint, 1.6f, Offset(it, 12f)) }
                CompanionSymbol.MoreVertical -> listOf(5f, 12f, 19f).forEach { drawCircle(tint, 1.6f, Offset(12f, it)) }
                CompanionSymbol.Search -> { drawCircle(tint, 6.5f, Offset(10.5f, 10.5f), style = stroke); line(15f, 15f, 21f, 21f) }
                CompanionSymbol.Chat -> drawPath(Path().apply {
                    moveTo(7f, 3f); lineTo(17f, 3f); quadraticTo(21f, 3f, 21f, 7f)
                    lineTo(21f, 14f); quadraticTo(21f, 18f, 17f, 18f)
                    lineTo(10f, 18f); lineTo(4f, 22f); lineTo(4f, 17f)
                    quadraticTo(3f, 16f, 3f, 14f); lineTo(3f, 7f); quadraticTo(3f, 3f, 7f, 3f); close()
                }, tint, style = stroke)
                CompanionSymbol.Shield -> { line(12f, 3f, 20f, 6f, 19f, 14f, 16f, 18f, 12f, 21f, 8f, 18f, 5f, 14f, 4f, 6f, 12f, 3f); line(8f, 11f, 11f, 14f, 16f, 9f) }
                CompanionSymbol.Scan -> {
                    line(8f, 3f, 3f, 3f, 3f, 8f); line(16f, 3f, 21f, 3f, 21f, 8f)
                    line(3f, 16f, 3f, 21f, 8f, 21f); line(21f, 16f, 21f, 21f, 16f, 21f)
                    line(7f, 12f, 17f, 12f)
                }
            }
        }
    }
}
