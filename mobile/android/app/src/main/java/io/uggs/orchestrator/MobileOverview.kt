package io.uggs.orchestrator

import org.json.JSONObject
import java.time.Instant

/** Use the server's receiver readiness, never a session's historical status. */
fun isReachable(agent: JSONObject): Boolean = agent.optBoolean("relay_ready", false) &&
    !agent.optBoolean("read_only", false) && agent.optString("presence") !in setOf("ended", "offline")

fun needsReply(agent: JSONObject) = agent.optJSONObject("pending_prompt") != null || agent.optJSONObject("attention") != null

fun readyAgents(agents: List<JSONObject>) = agents.filter(::isReachable)
    .sortedWith(compareByDescending<JSONObject> { it.optJSONObject("pending_prompt") != null }
        .thenByDescending { it.optJSONObject("attention") != null }
        .thenByDescending { it.optString("last_event_at") })

fun liveApproval(request: JSONObject, now: Long) = request.optBoolean("live", false) &&
    runCatching { Instant.parse(request.getString("expires_at")).toEpochMilli() > now }.getOrDefault(false)

fun agentTitle(agent: JSONObject): String {
    val name = compactSummary(agent.identityText("launch_name"))
    val title = compactSummary(agent.identityText("session_name"))
    if (name != null) {
        val prefix = "($name)"
        val task = compactSummary(agent.identityText("task_title")) ?: title
        return compactSummary(when {
            task == null -> prefix
            task == prefix || task.startsWith("$prefix ") -> task
            else -> "$prefix $task"
        })!!
    }
    return title
        ?: agent.identityText("upstream_session_id")?.let { "Session ${it.take(8)}" }
        ?: agent.identityText("id")?.let { "Session ${it.take(8)}" }
        ?: "Unnamed session"
}

private fun JSONObject.identityText(key: String): String? =
    if (isNull(key)) null else optString(key).trim().takeIf(String::isNotBlank)

internal fun agentHost(agent: JSONObject?): String? = agent?.let {
    it.optString("host").trim().ifBlank { it.optString("fqdn").trim() }.takeIf(String::isNotBlank)
}

fun compactSummary(value: String?): String? {
    val text = value?.replace(Regex("\\s+"), " ")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return if (text.codePointCount(0, text.length) > 160) text.substring(0, text.offsetByCodePoints(0, 159)).trimEnd() + "…" else text
}

fun agentSummary(agent: JSONObject): String? = compactSummary(agent.optJSONObject("preview")?.optString("summary"))
    ?: if (agent.optJSONObject("pending_prompt") != null) "Your reply is needed."
    else if (agent.optJSONObject("attention") != null) compactSummary(agent.getJSONObject("attention").optString("summary")) ?: "The agent needs your attention."
    else null

fun durationLabel(minutes: Int) = if (minutes >= 60 && minutes % 60 == 0) "${minutes / 60}h" else "${minutes}m"

fun conversationEvents(events: List<JSONObject>) = events.filter {
    it.optString("type") in setOf("user_message", "assistant_message") &&
        !it.optJSONObject("payload")?.optString("text").isNullOrBlank()
}
