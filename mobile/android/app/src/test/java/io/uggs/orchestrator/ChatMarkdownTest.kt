package io.uggs.orchestrator

import org.junit.Assert.*
import org.junit.Test

class ChatMarkdownTest {
    @Test fun aPlainParagraphIsOneSpanWithItsLineBreaks() {
        assertEquals(listOf(MdBlock.Paragraph(listOf(MdInline("Here is the photo for your review.")))), parseMarkdown("Here is the photo for your review."))
        assertEquals(listOf(MdBlock.Paragraph(listOf(MdInline("one\ntwo")))), parseMarkdown("one\ntwo"))
        assertEquals(2, parseMarkdown("one\n\ntwo").size)
    }

    @Test fun inlineStylesNestAndSnakeCaseStaysLiteral() {
        assertEquals(listOf(MdInline("a "), MdInline("bold", bold = true), MdInline(" and "), MdInline("it", italic = true), MdInline(" "), MdInline("x", code = true)),
            parseInline("a **bold** and *it* `x`"))
        assertEquals(listOf(MdInline("very ", bold = true), MdInline("much", bold = true, italic = true)), parseInline("**very _much_**"))
        assertEquals(listOf(MdInline("gone", strike = true)), parseInline("~~gone~~"))
        assertEquals(listOf(MdInline("snake_case_name and 2 * 3 * 4")), parseInline("snake_case_name and 2 * 3 * 4"))
        assertEquals(listOf(MdInline("**not closed")), parseInline("**not closed"))
        assertEquals(listOf(MdInline("*literal*")), parseInline("\\*literal\\*"))
        assertEquals(listOf(MdInline("**", code = true)), parseInline("`**`"))
    }

    @Test fun onlySafeLinksBecomeLinks() {
        assertEquals(listOf(MdInline("see "), MdInline("docs", link = "https://example.com/a")), parseInline("see [docs](https://example.com/a)"))
        assertEquals(listOf(MdInline("[x](javascript:alert(1))")), parseInline("[x](javascript:alert(1))"))
        assertEquals(listOf(MdInline("Open "), MdInline("https://uggs.io/path", link = "https://uggs.io/path"), MdInline(".")), parseInline("Open https://uggs.io/path."))
        assertEquals(listOf(MdInline("mail", link = "mailto:a@b.c")), parseInline("[mail](mailto:a@b.c)"))
        assertNull(safeLink("file:///etc/passwd"))
        assertNull(safeLink("https://a b"))
    }

    @Test fun blocksCoverHeadingsListsQuotesCodeAndRules() {
        val blocks = parseMarkdown("""
            # Title
            - first
            - second
              continued
              - nested
            1. one
            - [x] done
            > quoted **text**
            > more
            ---
            ```kotlin
            val x = "**not bold**"
            ```
            tail
        """.trimIndent())
        assertEquals(MdBlock.Heading(1, listOf(MdInline("Title"))), blocks[0])
        val list = blocks[1] as MdBlock.ListBlock
        assertEquals(listOf("•", "•", "◦", "1.", "☑"), list.items.map { it.marker })
        assertEquals(listOf(0, 0, 1, 0, 0), list.items.map { it.depth })
        assertEquals("second\ncontinued", list.items[1].inlines.joinToString("") { it.text })
        val quote = blocks[2] as MdBlock.Quote
        assertEquals(listOf(MdBlock.Paragraph(listOf(MdInline("quoted "), MdInline("text", bold = true), MdInline("\nmore")))), quote.blocks)
        assertEquals(MdBlock.Rule, blocks[3])
        assertEquals(MdBlock.Code("kotlin", "val x = \"**not bold**\""), blocks[4])
        assertEquals(MdBlock.Paragraph(listOf(MdInline("tail"))), blocks[5])
    }

    @Test fun anUnclosedFenceRunsToTheEndAndHtmlStaysText() {
        assertEquals(listOf(MdBlock.Code(null, "a\nb")), parseMarkdown("```\na\nb"))
        assertEquals(listOf(MdBlock.Paragraph(listOf(MdInline("<b>hi</b>")))), parseMarkdown("<b>hi</b>"))
    }
}
