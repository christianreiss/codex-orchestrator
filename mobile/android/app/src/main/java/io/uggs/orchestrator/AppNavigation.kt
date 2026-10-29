package io.uggs.orchestrator

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/** Navigation-Compose routes of the app shell. Pure strings so they stay unit-testable. */
internal object Routes {
    const val CHATS = "chats"
    const val QUOTAS = "quotas"
    const val HOSTS = "hosts"
    const val AUTHORIZATIONS = "authorizations"
    const val TOOLS = "tools"
    const val SEARCH = "search"
    const val CHAT_PATTERN = "chat/{key}"
    const val DEEP_LINK_SCHEME = "orchestrator"
    const val DEEP_LINK_HOST = "chat"

    /** [ConversationKey.storageKey] (`<agentId>` or `room:<roomId>`) as one URL-safe path segment. */
    fun encodeKey(storageKey: String): String = URLEncoder.encode(storageKey, "UTF-8").replace("+", "%20")
    fun decodeKey(segment: String): String? =
        runCatching { URLDecoder.decode(segment.replace("+", "%2B"), "UTF-8") }.getOrNull()?.takeIf { it.isNotBlank() }

    fun chat(key: ConversationKey) = "chat/" + encodeKey(key.storageKey)
    fun isChat(route: String?) = route != null && (route == CHAT_PATTERN || route.startsWith("chat/"))
    fun deepLink(key: ConversationKey) = "$DEEP_LINK_SCHEME://$DEEP_LINK_HOST/" + encodeKey(key.storageKey)

    /** `orchestrator://chat/{key}` to the conversation it names; anything else (including notification identities) is null. */
    fun parseDeepLink(uri: String?): ConversationKey? {
        if (uri == null) return null
        val parsed = runCatching { URI(uri) }.getOrNull() ?: return null
        if (parsed.scheme != DEEP_LINK_SCHEME || parsed.host != DEEP_LINK_HOST) return null
        val segment = parsed.rawPath?.removePrefix("/")?.takeIf { it.isNotEmpty() && '/' !in it } ?: return null
        val key = decodeKey(segment) ?: return null
        val parsedKey = ConversationKey.fromStorageKey(key)
        return parsedKey.takeUnless { it is ConversationKey.Room && it.roomId.isBlank() }
    }
}

/** Window width at which the conversation list and the open chat sit side by side. */
internal const val WIDE_WINDOW_DP = 840
internal const val CHAT_MAX_WIDTH_DP = 720
internal fun isWideWindow(widthDp: Int) = widthDp >= WIDE_WINDOW_DP

/** Quota usage severity: below 70 ok, 70 to 90 warning, above 90 error. Unknown is its own level. */
internal enum class QuotaLevel { OK, WARNING, ERROR, UNKNOWN }
internal fun quotaLevel(usedPercent: Double): QuotaLevel = when {
    !usedPercent.isFinite() -> QuotaLevel.UNKNOWN
    usedPercent > 90.0 -> QuotaLevel.ERROR
    usedPercent >= 70.0 -> QuotaLevel.WARNING
    else -> QuotaLevel.OK
}
