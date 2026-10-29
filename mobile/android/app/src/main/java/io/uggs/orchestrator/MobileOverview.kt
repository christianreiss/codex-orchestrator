package io.uggs.orchestrator

import org.json.JSONObject
import java.time.Instant

/** Use the server's receiver readiness, never a session's historical status. */
fun isReachable(agent: JSONObject): Boolean = agent.optBoolean("relay_ready", false) &&
    !agent.optBoolean("read_only", false) && !isClosedAgent(agent) && agent.optString("presence") != "offline"

fun isClosedAgent(agent: JSONObject): Boolean = agent.optString("presence") == "ended" ||
    (agent.optBoolean("daemon_session") && agent.optString("remote_status") in setOf("closed", "failed", "unknown"))

/** All lists live agents, including busy or idle clients with a closed relay. */
fun isOnlineActiveAgent(agent: JSONObject): Boolean =
    !isClosedAgent(agent) && !agent.optBoolean("read_only", false) &&
        agent.optString("presence") in setOf("listening", "working", "idle")

/** Keep retained history available independently of the selected list filter. */
fun retainedChats(agents: List<JSONObject>): List<JSONObject> =
    agents.sortedByDescending { it.optString("last_event_at") }

/** Retained chats that are no longer live (offline, ended, read-only): listed under "Recent", newest first. */
fun recentChats(agents: List<JSONObject>): List<JSONObject> = retainedChats(agents).filterNot(::isOnlineActiveAgent)

internal fun noticeSeverity(payload: JSONObject?): String? = payload?.optString("severity")
    ?.takeIf { it in setOf("important", "critical", "blocker") }

fun hasUrgentNotice(agent: JSONObject) = noticeSeverity(agent.optJSONObject("attention")) != null ||
    agent.optJSONArray("notices")?.objects()?.any { noticeSeverity(it) != null } == true
fun needsReply(agent: JSONObject) = agent.optJSONObject("attention") != null || (agent.optJSONObject("pending_prompt")?.let { !it.has("answer_mode") } ?: false)

fun readyAgents(agents: List<JSONObject>) = agents.filter(::isReachable)
    .sortedWith(compareByDescending<JSONObject> { it.optJSONObject("pending_prompt") != null }
        .thenByDescending { it.optJSONObject("attention") != null }
        .thenByDescending { it.optString("last_event_at") })

fun liveApproval(request: JSONObject, now: Long) = request.optBoolean("live", false) &&
    runCatching { Instant.parse(request.getString("expires_at")).toEpochMilli() > now }.getOrDefault(false)

fun liveWindow(window: JSONObject, now: Long) =
    runCatching { Instant.parse(window.getString("enabled_until")).toEpochMilli() > now }.getOrDefault(false)

fun liveFleetWindow(window: JSONObject?, now: Long) =
    window?.let { it.optBoolean("open", false) && liveWindow(it, now) } ?: false

internal fun agentTitle(t: Texts, agent: JSONObject): String {
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
        ?: agent.identityText("upstream_session_id")?.let { t.string(R.string.agent_session_short, it.take(8)) }
        ?: agent.identityText("id")?.let { t.string(R.string.agent_session_short, it.take(8)) }
        ?: t.string(R.string.agent_unnamed_session)
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

internal fun agentSummary(t: Texts, agent: JSONObject): String? = compactSummary(agent.optJSONObject("preview")?.optString("summary"))
    ?: if (agent.optJSONObject("pending_prompt") != null) t.string(R.string.agent_summary_reply_needed)
    else if (agent.optJSONObject("attention") != null) compactSummary(agent.getJSONObject("attention").optString("summary")) ?: t.string(R.string.agent_summary_attention)
    else null

internal fun durationLabel(t: Texts, minutes: Int) = if (minutes >= 60 && minutes % 60 == 0) t.string(R.string.duration_h, minutes / 60) else t.string(R.string.duration_m, minutes)

internal fun messageText(event: JSONObject): String {
    val payload = event.optJSONObject("payload") ?: return ""
    return payload.optString("text").takeIf { it.isNotBlank() }
        ?: if (noticeSeverity(payload) != null) payload.optString("summary").ifBlank { payload.optString("question") } else ""
}

fun conversationEvents(events: List<JSONObject>) = events.filter {
    val payload = it.optJSONObject("payload")
    val type = it.optString("type")
    (type in setOf("user_message", "assistant_message") ||
        (type in setOf("attention", "waiting_input") && noticeSeverity(payload) != null)) &&
        (messageText(it).isNotBlank() || (payload?.optJSONArray("attachments")?.length() ?: 0) > 0)
}
