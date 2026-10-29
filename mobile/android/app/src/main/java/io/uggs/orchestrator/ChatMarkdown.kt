package io.uggs.orchestrator

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/*
 * A small Markdown subset for chat: headings, paragraphs (line breaks kept),
 * bullet / numbered / task lists, block quotes, fenced code, rules, and inline
 * bold, italic, strike, code and links. The parser is pure Kotlin; HTML is never
 * evaluated, and only http(s) and mailto targets become links.
 */

internal data class MdInline(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val strike: Boolean = false,
    val code: Boolean = false,
    val link: String? = null,
)

internal data class MdListItem(val marker: String, val depth: Int, val inlines: List<MdInline>)

internal sealed interface MdBlock {
    data class Paragraph(val inlines: List<MdInline>) : MdBlock
    data class Heading(val level: Int, val inlines: List<MdInline>) : MdBlock
    data class ListBlock(val items: List<MdListItem>) : MdBlock
    data class Quote(val blocks: List<MdBlock>) : MdBlock
    data class Code(val language: String?, val code: String) : MdBlock
    data object Rule : MdBlock
}

private val HEADING = Regex("^ {0,3}(#{1,6})\\s+(.*?)\\s*#*\\s*$")
private val RULE = Regex("^ {0,3}([-*_])(\\s*\\1){2,}\\s*$")
private val QUOTE = Regex("^ {0,3}>\\s?(.*)$")
private val LIST_ITEM = Regex("^(\\s*)([-*+]|\\d{1,9}[.)])\\s+(.*)$")
private val FENCE = Regex("^ {0,3}(```+|~~~+)\\s*([^`\\s]*).*$")

internal fun parseMarkdown(text: String): List<MdBlock> = parseBlocks(text.replace("\r\n", "\n").split('\n'))

private fun parseBlocks(lines: List<String>): List<MdBlock> {
    val blocks = mutableListOf<MdBlock>()
    val paragraph = mutableListOf<String>()
    fun flush() { if (paragraph.isNotEmpty()) { blocks += MdBlock.Paragraph(parseInline(paragraph.joinToString("\n"))); paragraph.clear() } }
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val fence = FENCE.matchEntire(line)
        when {
            fence != null -> {
                flush()
                val marker = fence.groupValues[1]
                val body = mutableListOf<String>()
                i++
                while (i < lines.size && !lines[i].trimStart().let { it.startsWith(marker) && it.trim().all { c -> c == marker[0] } }) { body += lines[i]; i++ }
                blocks += MdBlock.Code(fence.groupValues[2].ifBlank { null }, body.joinToString("\n"))
            }
            line.isBlank() -> flush()
            HEADING.matches(line) -> {
                flush()
                val match = HEADING.matchEntire(line)!!
                blocks += MdBlock.Heading(match.groupValues[1].length, parseInline(match.groupValues[2]))
            }
            RULE.matches(line) -> { flush(); blocks += MdBlock.Rule }
            QUOTE.matches(line) -> {
                flush()
                val quoted = mutableListOf<String>()
                while (i < lines.size && QUOTE.matches(lines[i])) { quoted += QUOTE.matchEntire(lines[i])!!.groupValues[1]; i++ }
                blocks += MdBlock.Quote(parseBlocks(quoted))
                continue
            }
            LIST_ITEM.matches(line) -> {
                flush()
                val items = mutableListOf<MdListItem>()
                while (i < lines.size) {
                    val match = LIST_ITEM.matchEntire(lines[i])
                    if (match != null) {
                        val indent = match.groupValues[1].replace("\t", "    ").length
                        var body = match.groupValues[3]
                        val token = match.groupValues[2]
                        var marker = if (token[0].isDigit()) token.dropLast(1) + "." else if (indent >= 2) "◦" else "•"
                        when {
                            body.startsWith("[ ] ") -> { marker = "☐"; body = body.drop(4) }
                            body.startsWith("[x] ", ignoreCase = true) -> { marker = "☑"; body = body.drop(4) }
                        }
                        items += MdListItem(marker, (indent / 2).coerceAtMost(3), parseInline(body))
                    } else if (lines[i].isNotBlank() && lines[i].startsWith("  ") && items.isNotEmpty()) {
                        // An indented continuation line belongs to the previous item.
                        val last = items.removeAt(items.lastIndex)
                        items += last.copy(inlines = parseInline(inlineText(last.inlines) + "\n" + lines[i].trim()))
                    } else break
                    i++
                }
                blocks += MdBlock.ListBlock(items)
                continue
            }
            else -> paragraph += line
        }
        i++
    }
    flush()
    return blocks
}

private fun inlineText(inlines: List<MdInline>) = inlines.joinToString("") { it.text }

internal fun safeLink(url: String): String? {
    val trimmed = url.trim()
    val scheme = trimmed.substringBefore(':', "").lowercase()
    return trimmed.takeIf { scheme in setOf("http", "https", "mailto") && trimmed.length > scheme.length + 1 && trimmed.none { it.isWhitespace() } }
}

private val TRAILING_PUNCTUATION = ".,;:!?)'\""

internal fun parseInline(text: String): List<MdInline> {
    val out = mutableListOf<MdInline>()
    parseInlineInto(text, MdInline(""), out)
    // Merge neighbours that share a style so a plain paragraph is a single span.
    return out.fold(mutableListOf<MdInline>()) { acc, span ->
        val last = acc.lastOrNull()
        if (last != null && last.copy(text = "") == span.copy(text = "")) acc[acc.lastIndex] = last.copy(text = last.text + span.text) else if (span.text.isNotEmpty()) acc += span
        acc
    }
}

private fun parseInlineInto(text: String, style: MdInline, out: MutableList<MdInline>) {
    val plain = StringBuilder()
    fun emit() { if (plain.isNotEmpty()) { out += style.copy(text = plain.toString()); plain.clear() } }
    fun wordChar(index: Int) = index in text.indices && text[index].isLetterOrDigit()
    var i = 0
    while (i < text.length) {
        val c = text[i]
        if (c == '\\' && i + 1 < text.length && !text[i + 1].isLetterOrDigit() && !text[i + 1].isWhitespace()) { plain.append(text[i + 1]); i += 2; continue }
        if (c == '`') {
            val end = text.indexOf('`', i + 1)
            if (end > i + 1) { emit(); out += style.copy(text = text.substring(i + 1, end), code = true, bold = false, italic = false, strike = false); i = end + 1; continue }
        }
        if (style.link == null && c == '[') {
            val close = text.indexOf("](", i + 1)
            val end = if (close > i) text.indexOf(')', close + 2) else -1
            val target = if (end > close) safeLink(text.substring(close + 2, end)) else null
            if (target != null) { emit(); parseInlineInto(text.substring(i + 1, close), style.copy(link = target), out); i = end + 1; continue }
        }
        if (style.link == null && (text.startsWith("https://", i) || text.startsWith("http://", i)) && !wordChar(i - 1)) {
            var end = i
            while (end < text.length && !text[end].isWhitespace() && text[end] != '<' && text[end] != '>') end++
            while (end > i && text[end - 1] in TRAILING_PUNCTUATION) end--
            val url = text.substring(i, end)
            if (safeLink(url) != null && url.length > 8) { emit(); out += style.copy(text = url, link = url); i = end; continue }
        }
        val pair = text.startsWith("**", i) || text.startsWith("__", i) || text.startsWith("~~", i)
        if (pair) {
            val marker = text.substring(i, i + 2)
            val end = text.indexOf(marker, i + 2)
            val boundary = marker != "__" || (!wordChar(i - 1) && !wordChar(end + 2))
            if (end > i + 2 && !text[i + 2].isWhitespace() && boundary) {
                emit()
                parseInlineInto(text.substring(i + 2, end), if (marker == "~~") style.copy(strike = true) else style.copy(bold = true), out)
                i = end + 2; continue
            }
        }
        if ((c == '*' || c == '_') && i + 1 < text.length && !text[i + 1].isWhitespace() && text[i + 1] != c && (c == '*' || !wordChar(i - 1))) {
            var end = text.indexOf(c, i + 1)
            while (end > 0 && (text[end - 1].isWhitespace() || (c == '_' && wordChar(end + 1)))) end = text.indexOf(c, end + 1)
            if (end > i + 1) { emit(); parseInlineInto(text.substring(i + 1, end), style.copy(italic = true), out); i = end + 1; continue }
        }
        plain.append(c); i++
    }
    emit()
}

/** Colours the renderer needs from its bubble, so links and code stay legible on own and others' bubbles. */
internal data class MarkdownColors(val link: Color, val codeBackground: Color, val quoteBar: Color)

@Composable internal fun defaultMarkdownColors() = MarkdownColors(
    MaterialTheme.colorScheme.primary,
    MaterialTheme.colorScheme.onSurface.copy(alpha = .08f),
    MaterialTheme.colorScheme.outline,
)

internal fun annotate(inlines: List<MdInline>, colors: MarkdownColors): AnnotatedString = buildAnnotatedString {
    inlines.forEach { span ->
        val style = SpanStyle(
            fontWeight = if (span.bold) FontWeight.Bold else null,
            fontStyle = if (span.italic) FontStyle.Italic else null,
            fontFamily = if (span.code) FontFamily.Monospace else null,
            background = if (span.code) colors.codeBackground else Color.Unspecified,
            textDecoration = if (span.strike) TextDecoration.LineThrough else null,
        )
        if (span.link != null) withLink(LinkAnnotation.Url(span.link, TextLinkStyles(SpanStyle(color = colors.link, textDecoration = TextDecoration.Underline)))) { withStyle(style) { append(span.text) } }
        else withStyle(style) { append(span.text) }
    }
}

/** Display agent Markdown as native text; HTML is never evaluated. */
@Composable internal fun ChatMarkdown(text: String, modifier: Modifier = Modifier, colors: MarkdownColors = defaultMarkdownColors()) {
    val blocks = remember(text) { parseMarkdown(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) { blocks.forEach { MarkdownBlock(it, colors) } }
}

@Composable private fun MarkdownBlock(block: MdBlock, colors: MarkdownColors) {
    val body = MaterialTheme.typography.bodyLarge
    when (block) {
        is MdBlock.Paragraph -> Text(annotate(block.inlines, colors), style = body)
        is MdBlock.Heading -> Text(annotate(block.inlines, colors), style = when (block.level) {
            1 -> MaterialTheme.typography.titleLarge; 2 -> MaterialTheme.typography.titleMedium; else -> MaterialTheme.typography.titleSmall
        }, fontWeight = FontWeight.SemiBold)
        is MdBlock.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            block.items.forEach { item ->
                Row(Modifier.padding(start = (item.depth * 16).dp)) {
                    Text(item.marker, Modifier.widthIn(min = 20.dp).padding(end = 4.dp), style = body)
                    Text(annotate(item.inlines, colors), style = body)
                }
            }
        }
        is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(colors.quoteBar, RoundedCornerShape(2.dp)))
            Column(Modifier.padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                CompositionLocalProvider(LocalContentColor provides LocalContentColor.current.copy(alpha = .8f)) { block.blocks.forEach { MarkdownBlock(it, colors) } }
            }
        }
        is MdBlock.Code -> CodeBlock(block, colors)
        MdBlock.Rule -> HorizontalDivider(Modifier.padding(vertical = 4.dp), color = colors.quoteBar.copy(alpha = .5f))
    }
}

@Composable private fun CodeBlock(block: MdBlock.Code, colors: MarkdownColors) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember(block.code) { mutableStateOf(false) }
    val copyLabel = stringResource(R.string.chat_copy_code)
    Surface(shape = RoundedCornerShape(8.dp), color = colors.codeBackground, contentColor = LocalContentColor.current, modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(Modifier.fillMaxWidth().padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(block.language.orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = LocalContentColor.current.copy(alpha = .7f))
                TextButton(onClick = {
                    scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(copyLabel, block.code))); copied = true }
                }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(if (copied) stringResource(R.string.chat_copied) else copyLabel, style = MaterialTheme.typography.labelMedium)
                }
            }
            Text(block.code, Modifier.horizontalScroll(rememberScrollState()).padding(start = 10.dp, end = 10.dp, bottom = 10.dp),
                style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = MaterialTheme.typography.bodySmall.fontSize, lineHeight = MaterialTheme.typography.bodySmall.lineHeight), softWrap = false)
        }
    }
}
