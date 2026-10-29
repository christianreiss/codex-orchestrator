package io.uggs.orchestrator

import androidx.annotation.StringRes
import org.json.JSONObject
import java.time.Instant

private fun instant(value: String): Long? = runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()

internal enum class ChatAgentStatus(@StringRes val label: Int) {
    ONLINE(R.string.status_online), WORKING(R.string.status_working), OFFLINE(R.string.status_offline), UNKNOWN(R.string.status_unknown)
}

/** Connection freshness gates live claims; receiver readiness only gates delivery. */
internal fun chatAgentStatus(agent: JSONObject, now: Long, fresh: Boolean): ChatAgentStatus {
    if (!fresh) return ChatAgentStatus.UNKNOWN
    if (isClosedAgent(agent) || agent.optString("presence") == "offline") return ChatAgentStatus.OFFLINE
    if (!isOnlineActiveAgent(agent)) return ChatAgentStatus.UNKNOWN
    return when (nativeActivity(agent, now)) {
        "working" -> ChatAgentStatus.WORKING
        "idle", "waiting" -> ChatAgentStatus.ONLINE
        "unknown" -> ChatAgentStatus.UNKNOWN
        else -> if (agent.optString("presence") == "working") ChatAgentStatus.WORKING else ChatAgentStatus.ONLINE
    }
}

fun nativeActivity(agent: JSONObject, now: Long): String? {
    val a = agent.optJSONObject("activity") ?: return null
    if (a.optString("source") == "portal-question" && agent.optJSONObject("pending_prompt") != null) return "waiting"
    if ((instant(a.optString("expires_at")) ?: 0) <= now) return "unknown"
    agent.optJSONObject("receiver")?.let { receiver ->
        val beat = instant(receiver.optString("heartbeat_at")) ?: 0
        if (!receiver.isNull("failure") || beat > now || now - beat >= 45_000) return "unknown"
    }
    return a.optString("state").takeIf { it in setOf("working", "idle", "waiting", "unknown") } ?: "unknown"
}

internal fun activityLabel(t: Texts, agent: JSONObject, now: Long): String {
    if (isClosedAgent(agent)) return t.string(R.string.status_ended)
    if (agent.optString("presence") == "offline") return t.string(R.string.status_offline)
    return when (nativeActivity(agent, now)) {
        "working" -> t.string(R.string.status_working)
        "idle" -> t.string(R.string.status_idle)
        "waiting" -> t.string(R.string.status_waiting_you)
        "unknown" -> t.string(R.string.status_unknown)
        else -> when (agent.optString("presence")) { "working" -> t.string(R.string.status_working); "listening" -> t.string(R.string.status_listening); else -> t.string(R.string.status_not_listening) }
    }
}

internal fun activityDetail(t: Texts, agent: JSONObject, now: Long): String {
    val label = activityLabel(t, agent, now)
    if (label in setOf(t.string(R.string.status_ended), t.string(R.string.status_offline))) return label
    val connection = if (isReachable(agent)) t.string(R.string.status_can_receive) else t.string(R.string.status_receiver_unavailable)
    return t.string(R.string.status_with_connection, label, connection)
}
