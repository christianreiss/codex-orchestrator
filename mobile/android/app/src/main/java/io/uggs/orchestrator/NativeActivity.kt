package io.uggs.orchestrator

import org.json.JSONObject
import java.time.Instant

private fun instant(value: String): Long? = runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()

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

fun activityLabel(agent: JSONObject, now: Long): String {
    if (isClosedAgent(agent)) return "Ended"
    if (agent.optString("presence") == "offline") return "Offline"
    return when (nativeActivity(agent, now)) {
        "working" -> "Working"
        "idle" -> "Idle"
        "waiting" -> "Waiting for you"
        "unknown" -> "Unknown"
        else -> when (agent.optString("presence")) { "working" -> "Working"; "listening" -> "Listening"; else -> "Not listening" }
    }
}

fun activityDetail(agent: JSONObject, now: Long): String {
    val label = activityLabel(agent, now)
    if (label in setOf("Ended", "Offline")) return label
    val connection = if (isReachable(agent)) "Can receive messages" else "Receiver unavailable"
    return "$label · $connection"
}
