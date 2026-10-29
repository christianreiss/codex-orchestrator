package io.uggs.orchestrator

import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

/*
 * Pure model of the server's mobile tools (R4): feature flags, response parsers, the
 * optimistic schedule reducers, feedback drafts, plan mode rules and the quota push.
 * Everything here is JVM-testable; ToolsState.kt and ToolsScreen.kt build on it.
 */

/** The Tools sections, in display order. */
internal enum class ToolSection { WORKFLOWS, SCHEDULES, GIT, PROJECTS, FEEDBACK }

/** The `/me` feature flags of the mobile tools; every flag missing means the server predates the route. */
internal data class ToolsFlags(
    val workflows: Boolean = false,
    val schedules: Boolean = false,
    val git: Boolean = false,
    val projects: Boolean = false,
    val feedback: Boolean = false,
    val remoteStop: Boolean = false,
    val permissionMode: Boolean = false,
    val quotaPush: Boolean = false,
) {
    companion object {
        val NONE = ToolsFlags()
        fun from(me: JSONObject?): ToolsFlags = if (me == null) NONE else ToolsFlags(
            workflows = me.optInt("workflows_protocol", 0) >= 1,
            schedules = me.optInt("schedules_protocol", 0) >= 1,
            git = me.optInt("git_director_protocol", 0) >= 1,
            projects = me.optInt("project_board_protocol", 0) >= 1,
            feedback = me.optInt("feedback_protocol", 0) >= 1,
            remoteStop = me.optInt("remote_stop_protocol", 0) >= 1,
            permissionMode = me.optInt("permission_mode_protocol", 0) >= 1,
            quotaPush = me.optInt("quota_push_protocol", 0) >= 1,
        )
    }

    fun has(section: ToolSection) = when (section) {
        ToolSection.WORKFLOWS -> workflows
        ToolSection.SCHEDULES -> schedules
        ToolSection.GIT -> git
        ToolSection.PROJECTS -> projects
        ToolSection.FEEDBACK -> feedback
    }
}

private val SECTION_CAPABILITY = mapOf(
    ToolSection.WORKFLOWS to "workflows.read",
    ToolSection.SCHEDULES to "agent_messaging.read",
    ToolSection.GIT to "git_director.read",
    ToolSection.PROJECTS to "projects.read",
    ToolSection.FEEDBACK to "feedback.manage",
)

/** Sections the operator may see: advertised by the server, permitted, and not answered with 404 earlier. */
internal fun availableToolSections(flags: ToolsFlags, capabilities: Set<String>, unavailable: Set<ToolSection> = emptySet()): List<ToolSection> =
    ToolSection.entries.filter { flags.has(it) && SECTION_CAPABILITY.getValue(it) in capabilities && it !in unavailable }

private fun JSONObject.text(name: String): String? = if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
private fun JSONObject.longOrNull(name: String): Long? = if (has(name) && !isNull(name)) optLong(name) else null

// Workflow runs

internal data class WorkflowRun(
    val runId: String, val title: String, val status: String, val outcome: String?, val summary: String?, val reportUrl: String?,
    val openItems: Int?, val awaitingDecision: String?, val updatedAt: String?,
)
internal data class WorkflowPage(val enabled: Boolean, val runs: List<WorkflowRun>, val nextCursor: Int?)

internal fun parseWorkflowRuns(json: JSONObject): WorkflowPage = WorkflowPage(
    enabled = json.optBoolean("enabled", true),
    runs = json.optJSONArray("runs")?.objects().orEmpty().mapNotNull { run ->
        val id = run.text("run_id") ?: return@mapNotNull null
        WorkflowRun(id, run.text("title") ?: id, run.optString("status"), run.text("outcome"), run.text("summary"), run.text("report_url"),
            run.longOrNull("open_items")?.toInt(), run.text("awaiting_decision"), run.text("updated_at"))
    },
    nextCursor = json.longOrNull("next_cursor")?.toInt(),
)

/** Only plain web links are opened from a report; anything else (intent:, file:, javascript:) is dropped. */
internal fun safeReportUrl(raw: String?): String? {
    val url = raw?.trim()?.takeIf { it.length <= 2048 } ?: return null
    val scheme = runCatching { java.net.URI(url).scheme }.getOrNull()?.lowercase()
    return url.takeIf { scheme == "http" || scheme == "https" }
}

// Schedules

internal data class ScheduleItem(
    val id: String, val name: String, val target: String?, val kind: String, val at: String?, val cron: String?, val intervalMinutes: Int?,
    val timezone: String?, val enabled: Boolean, val pauseReason: String?, val nextRunAt: String?, val version: Long,
    val lastStatus: String?, val lastError: String?,
    /** A pause or resume is in flight: the row shows the requested state and rejects another tap. */
    val pending: Boolean = false,
) {
    val paused get() = !enabled
}

internal fun parseSchedule(json: JSONObject): ScheduleItem? {
    val id = json.text("id") ?: return null
    val last = json.optJSONObject("last_run")
    return ScheduleItem(
        id = id, name = json.text("name") ?: id, target = json.text("target"), kind = json.optString("kind"), at = json.text("at"), cron = json.text("cron"),
        intervalMinutes = json.longOrNull("interval_minutes")?.toInt(), timezone = json.text("timezone"),
        enabled = json.optBoolean("enabled", !json.optBoolean("paused", false)), pauseReason = json.text("pause_reason"),
        nextRunAt = json.text("next_run_at"), version = json.optLong("version", 1), lastStatus = last?.text("status"),
        lastError = json.text("last_error") ?: last?.text("last_error"),
    )
}

internal fun parseSchedules(json: JSONObject): List<ScheduleItem> = json.optJSONArray("schedules")?.objects().orEmpty().mapNotNull(::parseSchedule)

/** The optimistic row for a pause or resume request: new state, no next run while paused, marked in flight. */
internal fun List<ScheduleItem>.withPending(id: String, pause: Boolean): List<ScheduleItem> =
    map { if (it.id == id) it.copy(enabled = !pause, nextRunAt = if (pause) null else it.nextRunAt, pending = true) else it }

/** The server's answer replaces the optimistic row (new version, real next run). */
internal fun List<ScheduleItem>.settled(updated: ScheduleItem): List<ScheduleItem> = map { if (it.id == updated.id) updated.copy(pending = false) else it }

/** A failed request restores the row exactly as it was before the tap. */
internal fun List<ScheduleItem>.reverted(original: ScheduleItem): List<ScheduleItem> = map { if (it.id == original.id) original.copy(pending = false) else it }

/** Whether a schedule can be toggled now: not in flight and the operator may manage. */
internal fun canToggleSchedule(item: ScheduleItem, canManage: Boolean) = canManage && !item.pending

internal fun scheduleErrorRes(status: Int, code: String?): Int? = when {
    status == 409 && code == "schedule_version_conflict" -> R.string.tools_sched_conflict
    status == 403 && code == "watchdog_schedule_managed" -> R.string.tools_sched_watchdog
    status == 403 -> R.string.tools_sched_forbidden
    status == 404 -> R.string.tools_sched_gone
    else -> null
}

// Git Director

internal data class GitMerge(
    val requestId: String, val status: String, val decidedBy: String?, val reason: String?, val repo: String?, val host: String?,
    val targetBranch: String?, val branch: String?, val task: String?, val ageSeconds: Long?,
)
internal data class GitMergePage(val enabled: Boolean, val merges: List<GitMerge>)

internal fun parseGitMerges(json: JSONObject): GitMergePage = GitMergePage(
    enabled = json.optBoolean("enabled", true),
    merges = json.optJSONArray("merges")?.objects().orEmpty().mapNotNull { m ->
        val id = m.text("request_id") ?: return@mapNotNull null
        GitMerge(id, m.optString("status"), m.text("decided_by"), m.text("reason"), m.text("repo"), m.text("host"), m.text("target_branch"), m.text("branch"),
            m.optJSONObject("agent")?.text("task"), m.longOrNull("age_seconds"))
    },
)

/** `5 min` style age without a locale clock: seconds, minutes, hours, days. */
internal fun mergeAge(t: Texts, seconds: Long?): String? = seconds?.let {
    when {
        it < 60 -> t.string(R.string.tools_age_seconds, it)
        it < 3600 -> t.string(R.string.tools_age_minutes, it / 60)
        it < 86400 -> t.string(R.string.tools_age_hours, it / 3600)
        else -> t.string(R.string.tools_age_days, it / 86400)
    }
}

// Projects

internal data class ProjectSummary(val slug: String, val title: String, val description: String)
internal data class ProjectList(val boardEnabled: Boolean, val projects: List<ProjectSummary>)
internal data class BoardCard(
    val id: String, val number: Long?, val title: String, val labels: List<String>, val priority: String?, val dueAt: String?,
    val status: String, val blockedReason: String?, val assignee: String?,
)
internal data class BoardColumn(
    val id: String, val title: String, val cardCount: Int, val wipLimit: Int?, val overWip: Boolean, val truncated: Boolean, val cards: List<BoardCard>,
)
internal data class ProjectBoard(val title: String?, val columns: List<BoardColumn>)

internal fun parseProjects(json: JSONObject): ProjectList = ProjectList(
    boardEnabled = json.optBoolean("board_enabled", true),
    projects = json.optJSONArray("projects")?.objects().orEmpty().mapNotNull { p ->
        val slug = p.text("slug") ?: return@mapNotNull null
        ProjectSummary(slug, p.text("title") ?: slug, p.optString("description"))
    },
)

internal fun parseBoard(json: JSONObject): ProjectBoard = ProjectBoard(
    title = json.optJSONObject("project")?.text("title"),
    columns = json.optJSONArray("columns")?.objects().orEmpty().map { c ->
        val cards = c.optJSONArray("cards")?.objects().orEmpty().mapNotNull { card ->
            val id = card.opt("id")?.toString()?.takeIf { it.isNotBlank() && it != "null" } ?: return@mapNotNull null
            val assignee = card.optJSONObject("assignee")?.let { a -> listOfNotNull(a.text("username"), a.text("host")?.let { "@$it" }).joinToString("").takeIf { it.isNotBlank() } }
            BoardCard(id, card.longOrNull("number"), card.text("title") ?: id, card.optJSONArray("labels")?.let { l -> (0 until l.length()).mapNotNull { l.optString(it).takeIf(String::isNotBlank) } }.orEmpty(),
                card.text("priority"), card.text("due_at"), card.optString("status", "open"), card.text("blocked_reason"), assignee)
        }
        BoardColumn(c.opt("id")?.toString().orEmpty(), c.text("title") ?: c.text("key").orEmpty(), c.optInt("card_count", cards.size), c.longOrNull("wip_limit")?.toInt(),
            c.optBoolean("over_wip"), c.optBoolean("truncated"), cards)
    },
)

// Feedback

internal val FEEDBACK_TYPES = listOf("bug", "feature", "feedback")
internal val FEEDBACK_PRIORITIES = listOf("low", "normal", "high", "critical")
internal const val FEEDBACK_TITLE_MAX = 255
internal const val FEEDBACK_DESCRIPTION_MAX = 32000
internal const val FEEDBACK_COMPONENT_MAX = 100

internal data class FeedbackDraft(val type: String, val title: String, val description: String, val component: String = "", val priority: String? = null) {
    /** Resource id of the first problem, or null when the draft can be sent. */
    fun problem(): Int? = when {
        type !in FEEDBACK_TYPES -> R.string.tools_fb_error_type
        title.trim().isEmpty() -> R.string.tools_fb_error_title
        title.trim().length > FEEDBACK_TITLE_MAX -> R.string.tools_fb_error_title
        description.trim().isEmpty() -> R.string.tools_fb_error_description
        description.trim().length > FEEDBACK_DESCRIPTION_MAX -> R.string.tools_fb_error_description
        component.trim().length > FEEDBACK_COMPONENT_MAX -> R.string.tools_fb_error_component
        priority != null && priority !in FEEDBACK_PRIORITIES -> R.string.tools_fb_error_priority
        else -> null
    }

    fun body(clientRequestId: String): JSONObject = JSONObject().put("client_request_id", clientRequestId).put("type", type)
        .put("title", title.trim()).put("description", description.trim())
        .apply { component.trim().takeIf { it.isNotEmpty() }?.let { put("component", it) }; priority?.let { put("priority", it) } }
}

/** A sent-or-failed submission. The id stays the same for an unchanged draft: the server replays instead of duplicating, and rejects a changed body under an old id. */
internal data class FeedbackAttempt(val draft: FeedbackDraft, val clientRequestId: String)

internal fun feedbackAttempt(draft: FeedbackDraft, previous: FeedbackAttempt?, newId: () -> String = { UUID.randomUUID().toString() }): FeedbackAttempt =
    if (previous != null && previous.draft == draft) previous else FeedbackAttempt(draft, newId())

/** Whether a failed submission may be retried with the same id: only when the server did not give a definitive answer. */
internal fun feedbackRetryKeepsId(status: Int?) = status == null || status >= 500

// Time formatting

internal fun toolsTime(t: Texts, raw: String?, zone: ZoneId = ZoneId.systemDefault()): String? = runCatching {
    DateTimeFormatter.ofPattern(t.pattern("dMMMHm", "d MMM, HH:mm"), t.locale).withZone(zone).format(Instant.parse(raw))
}.getOrNull()

internal fun scheduleTiming(t: Texts, item: ScheduleItem, zone: ZoneId = ZoneId.systemDefault()): String = when (item.kind) {
    "once" -> toolsTime(t, item.at, zone)?.let { t.string(R.string.tools_sched_once, it) } ?: t.string(R.string.tools_sched_once_unknown)
    "cron" -> t.string(R.string.tools_sched_cron, item.cron.orEmpty(), item.timezone ?: "UTC")
    "interval" -> item.intervalMinutes?.let { t.plural(R.plurals.tools_sched_interval, it, it) } ?: t.string(R.string.tools_sched_recurring)
    else -> t.string(R.string.tools_sched_recurring)
}

// Plan mode

internal const val PLAN_MODE = "plan"
internal const val DEFAULT_MODE = "default"

/** Why the "Plan first" switch is not usable for [engine] on [host]. */
internal enum class PlanAvailability { OFFERED, ENGINE_UNSUPPORTED, HOST_UNSUPPORTED }

/** `permission_modes:{<engine>:[...]}` of a host card lists `plan` only where a start accepts it. */
internal fun planAvailability(host: JSONObject, engine: String): PlanAvailability {
    val modes = host.optJSONObject("permission_modes")?.optJSONArray(engine)?.strings().orEmpty()
    return when {
        PLAN_MODE in modes -> PlanAvailability.OFFERED
        engine == "codex" -> PlanAvailability.ENGINE_UNSUPPORTED
        else -> PlanAvailability.HOST_UNSUPPORTED
    }
}

/** A plan-first start needs a task; without one the sheet blocks the start. */
internal fun planStartProblem(plan: Boolean, task: String): Int? = if (plan && task.isBlank()) R.string.start_plan_needs_task else null

/** Start errors of plan mode, as the server reports them (422 engine unsupported, 409 old daemon). */
internal fun planStartErrorRes(status: Int, code: String?): Int? = when {
    status == 422 && code == "permission_mode_engine_unsupported" -> R.string.plan_error_engine
    status == 409 && code == "permission_mode_unsupported" -> R.string.plan_error_host
    else -> null
}

/** True for a plan-mode remote session that is still open. */
internal fun isPlanSession(agent: JSONObject?): Boolean = agent != null && agent.optBoolean("daemon_session") &&
    agent.optString("permission_mode") == PLAN_MODE && agent.optString("remote_status") !in setOf("closed", "failed")

internal enum class PlanBanner { HIDDEN, WORKING, READY }

/** The banner shows for every open plan session; the approve button is live only while the agent is idle or waiting and the operator may resume it. */
internal fun planBanner(agent: JSONObject?, capabilities: Set<String>, fresh: Boolean, busy: Boolean = false): PlanBanner = when {
    !isPlanSession(agent) -> PlanBanner.HIDDEN
    fresh && !busy && agent!!.optString("remote_status") in setOf("idle", "waiting") &&
        setOf("agent_messaging.manage", "agent_portal.manage", "agent_portal.reveal_transcript").all { it in capabilities } -> PlanBanner.READY
    else -> PlanBanner.WORKING
}

/**
 * The open question to answer with the approval, when it is the plan question: it must offer an `approve` choice,
 * because the server answers it with that value. Anything else is left open for the operator.
 */
internal fun planPromptId(agent: JSONObject?): String? {
    val prompt = agent?.optJSONObject("pending_prompt") ?: return null
    val id = prompt.optString("id").takeIf { it.isNotBlank() } ?: return null
    val values = prompt.optJSONArray("choices")?.objects()?.map { it.optString("value") }.orEmpty() + (prompt.optJSONArray("options")?.strings().orEmpty())
    return id.takeIf { values.any { it.equals("approve", ignoreCase = true) } }
}

internal fun planApprovalBody(clientMessageId: String, promptId: String?): JSONObject =
    JSONObject().put("mode", DEFAULT_MODE).put("client_message_id", clientMessageId).apply { promptId?.let { put("prompt_id", it) } }

internal fun planApprovalErrorRes(status: Int, code: String?): Int? = when (status) {
    409 -> R.string.plan_approve_conflict
    422 -> R.string.plan_approve_rejected
    403 -> R.string.plan_approve_forbidden
    404 -> R.string.plan_approve_gone
    else -> null
}

/** One approval id per tap, kept for a retry after a lost answer and dropped after a definitive one. */
internal class PlanApprovals(private val newId: () -> String = { UUID.randomUUID().toString() }) {
    private val ids = mutableMapOf<String, String>()
    fun idFor(session: String): String = ids.getOrPut(session, newId)
    fun settle(session: String, status: Int?) { if (status != null && status < 500) ids.remove(session) }
    fun done(session: String) { ids.remove(session) }
}

/** The start request of a remote session; `permission_mode` is only sent for a plan-first start. */
internal fun startBody(hostId: Long, engine: String, task: String, title: String, cwd: String, plan: Boolean, clientMessageId: String): JSONObject =
    JSONObject().put("host_id", hostId).put("engine", engine).put("task", task.trim()).put("title", title.trim()).put("client_message_id", clientMessageId)
        .apply { if (cwd.isNotBlank()) put("cwd", cwd.trim()); if (plan) put("permission_mode", PLAN_MODE) }

/** A remote session this operator started that can still be stopped. */
internal fun canStopSession(agent: JSONObject?, flags: ToolsFlags, capabilities: Set<String>, fresh: Boolean): Boolean =
    agent != null && flags.remoteStop && fresh && agent.optBoolean("daemon_session") && "agent_messaging.manage" in capabilities &&
        agent.optString("remote_status") in setOf("queued", "running", "idle", "waiting")

// Quota push

internal data class QuotaPush(
    val notificationId: String, val engine: String, val accountId: String, val accountLabel: String?, val window: String,
    val usedPercent: Double?, val threshold: Int?, val resetsAt: String?, val summary: String?,
)

/** Null for anything but a well-formed `kind:"quota"` push. */
internal fun parseQuotaPush(data: Map<String, String>): QuotaPush? {
    if (data["kind"] != "quota") return null
    fun field(name: String, max: Int = 256) = data[name]?.trim()?.takeIf { it.isNotEmpty() && it.length <= max }
    val id = field("notification_id") ?: return null
    val engine = field("engine", 40)?.lowercase() ?: return null
    return QuotaPush(
        id, engine, field("account_id") ?: field("target_id") ?: return null, field("account_label", 200), field("window", 40) ?: "short",
        data["used_percent"]?.toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0 }, data["threshold"]?.toDoubleOrNull()?.toInt(),
        field("resets_at", 64)?.takeIf { runCatching { Instant.parse(it) }.isSuccess }, compactSummary(data["summary"]),
    )
}

internal fun engineLabel(engine: String) = when (engine) { "codex" -> "Codex"; "claude" -> "Claude"; "grok" -> "Grok"; else -> engine.replaceFirstChar { it.uppercase() } }

internal fun quotaPushWindow(t: Texts, window: String) = t.string(when (window) {
    "weekly" -> R.string.quota_window_weekly
    "monthly" -> R.string.quota_window_monthly
    else -> R.string.quota_window_short
})

internal fun quotaPushTitle(t: Texts, push: QuotaPush) = t.string(R.string.notif_quota_title, engineLabel(push.engine))

/** `Weekly: 87% used · resets 3 Nov, 14:00`; the percentage and reset time are omitted when the push lacks them. */
internal fun quotaPushText(t: Texts, push: QuotaPush, zone: ZoneId = ZoneId.systemDefault()): String {
    val window = quotaPushWindow(t, push.window)
    val used = push.usedPercent?.let { t.string(R.string.quota_percent_used, String.format(t.locale, "%.0f", it)) }
    val reset = toolsTime(t, push.resetsAt, zone)?.let { t.string(R.string.quota_resets, it) }
    return listOfNotNull(used?.let { t.string(R.string.notif_quota_used, window, it) } ?: window, reset).joinToString(" · ")
}

/** One notification per account window; a later warning of the same window replaces it. */
internal fun quotaNotificationTag(scope: String, push: QuotaPush) = "quota:$scope:${push.engine}:${push.accountId}:${push.window}"
