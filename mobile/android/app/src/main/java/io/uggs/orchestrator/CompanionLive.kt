package io.uggs.orchestrator

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/** One frame of the companion live socket (`/companion/v1/ws`). */
internal sealed interface LiveFrame {
    data object Hello : LiveFrame
    data class Changed(val scopes: Set<String>) : LiveFrame
    data object Ping : LiveFrame
}

/** Returns null for malformed or unknown frames; those do not count as liveness. */
internal fun parseLiveFrame(text: String): LiveFrame? {
    val frame = runCatching { JSONObject(text) }.getOrNull() ?: return null
    return when (frame.optString("type")) {
        "hello" -> LiveFrame.Hello
        "changed" -> LiveFrame.Changed(frame.optJSONArray("scopes")?.strings() ?: emptySet())
        "ping" -> LiveFrame.Ping
        else -> null
    }
}

/** Exponential reconnect backoff: 1 s doubling to at most 30 s. */
internal fun reconnectDelay(attempt: Int): Long = (1000L shl attempt.coerceAtMost(5)).coerceAtMost(30_000L)

/**
 * Socket callbacks run on OkHttp threads; every callback hops to [scope] and is
 * dropped unless the socket generation that opened it is still [current].
 * Frames are additionally dropped while the app is not [foreground].
 */
internal fun liveSocketListener(
    scope: CoroutineScope,
    current: () -> Boolean,
    foreground: () -> Boolean,
    onFrame: (LiveFrame) -> Unit,
    onEnded: (revoked: Boolean) -> Unit,
): WebSocketListener = object : WebSocketListener() {
    override fun onMessage(webSocket: WebSocket, text: String) {
        scope.launch {
            if (!current() || !foreground()) return@launch
            onFrame(parseLiveFrame(text) ?: return@launch)
        }
    }
    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        scope.launch { if (current()) onEnded(code == 4001) }
    }
    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        scope.launch { if (current()) onEnded(response?.code == 401) }
    }
}
