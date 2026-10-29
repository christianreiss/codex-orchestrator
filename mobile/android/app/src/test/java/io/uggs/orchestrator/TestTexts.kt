package io.uggs.orchestrator

import java.io.File
import java.util.Locale
import javax.xml.parsers.DocumentBuilderFactory

/** English [Texts] backed by the real string resource files, so tests assert the shipped wording. */
internal object TestTexts : Texts {
    override val locale: Locale = Locale.ENGLISH
    private val strings = mutableMapOf<String, String>()
    private val plurals = mutableMapOf<String, MutableMap<String, String>>()
    private val stringNames: Map<Int, String> = names(R.string::class.java)
    private val pluralNames: Map<Int, String> = names(R.plurals::class.java)

    init {
        val dir = listOf("src/main/res/values", "app/src/main/res/values").map(::File).first { it.isDirectory }
        dir.listFiles { f -> f.name.startsWith("strings") && f.extension == "xml" }!!.forEach { file ->
            val root = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file).documentElement
            for (i in 0 until root.childNodes.length) {
                val node = root.childNodes.item(i) as? org.w3c.dom.Element ?: continue
                when (node.tagName) {
                    "string" -> strings[node.getAttribute("name")] = unescape(node.textContent)
                    "plurals" -> {
                        val items = plurals.getOrPut(node.getAttribute("name")) { mutableMapOf() }
                        val children = node.getElementsByTagName("item")
                        for (j in 0 until children.length) {
                            val item = children.item(j) as org.w3c.dom.Element
                            items[item.getAttribute("quantity")] = unescape(item.textContent)
                        }
                    }
                }
            }
        }
    }

    private fun names(type: Class<*>): Map<Int, String> = type.fields.filter { it.type == Int::class.javaPrimitiveType }.associate { (it.get(null) as Int) to it.name }
    private fun unescape(raw: String) = raw.trim().removeSurrounding("\"").replace("\\'", "'").replace("\\n", "\n").replace("\\\"", "\"").replace("\\@", "@")

    override fun string(id: Int, vararg args: Any): String = String.format(locale, strings.getValue(stringNames.getValue(id)), *args)
    override fun plural(id: Int, count: Int, vararg args: Any): String {
        val items = plurals.getValue(pluralNames.getValue(id))
        return String.format(locale, if (count == 1) items.getValue("one") else items.getValue("other"), *args)
    }
    override fun pattern(skeleton: String, fallback: String): String = fallback
}
