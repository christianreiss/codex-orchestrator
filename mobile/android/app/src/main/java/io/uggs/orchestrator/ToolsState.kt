package io.uggs.orchestrator

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/** One loadable list: its value, whether a request runs, and the last error. */
internal class Loadable<T>(initial: T) {
    var value by mutableStateOf(initial)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var loaded by mutableStateOf(false)
    fun reset(initial: T) { value = initial; loading = false; error = null; loaded = false }
}

/**
 * The mobile tools (workflow runs, schedules, Git merges, project board, feedback). Each section is gated by its `/me`
 * flag and by the operator's capability; a 404 from an older server hides the section. Results are applied only while
 * [fence] (connection and live generation) is unchanged.
 */
internal class ToolsState(
    private val api: () -> Api,
    private val scope: CoroutineScope,
    private val permitted: () -> Boolean,
    private val fence: () -> Any?,
    private val texts: Texts,
    private val report: (String) -> Unit,
    private val capabilities: () -> Set<String>,
) {
    var flags by mutableStateOf(ToolsFlags.NONE); private set
    var unavailable by mutableStateOf<Set<ToolSection>>(emptySet()); private set
    val workflows = Loadable(WorkflowPage(true, emptyList(), null))
    val workflowsMore = Loadable(false)
    val schedules = Loadable<List<ScheduleItem>>(emptyList())
    val git = Loadable(GitMergePage(true, emptyList()))
    val projects = Loadable(ProjectList(true, emptyList()))
    val board = Loadable<ProjectBoard?>(null)
    var feedbackBusy by mutableStateOf(false); private set
    private var feedbackPending: FeedbackAttempt? = null

    fun applyMe(me: JSONObject) { flags = ToolsFlags.from(me) }
    fun sections(): List<ToolSection> = availableToolSections(flags, capabilities(), unavailable)

    fun clear() {
        flags = ToolsFlags.NONE; unavailable = emptySet()
        workflows.reset(WorkflowPage(true, emptyList(), null)); schedules.reset(emptyList()); git.reset(GitMergePage(true, emptyList()))
        projects.reset(ProjectList(true, emptyList())); board.reset(null)
        feedbackBusy = false; feedbackPending = null
    }

    private suspend fun <T> load(section: ToolSection, target: Loadable<T>, hideOn404: Boolean = true, apply: (T) -> T = { it }, call: suspend (Api) -> T) {
        if (!permitted() || target.loading) return
        val owner = fence()
        target.loading = true
        try {
            val result = call(api())
            if (fence() == owner) { target.value = apply(result); target.error = null; target.loaded = true }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            if (fence() == owner) {
                if (e is ApiException && e.status == 404 && hideOn404) unavailable = unavailable + section
                else target.error = failureText(e)
            }
        } finally { target.loading = false }
    }

    private fun failureText(e: Exception) = when {
        e is ApiException && e.status == 403 -> texts.string(R.string.tools_error_forbidden)
        e is ApiException && e.status == 409 && e.code == "project_board_disabled" -> texts.string(R.string.tools_projects_board_disabled)
        e is ApiException && e.message?.isNotBlank() == true -> e.message!!
        else -> texts.string(R.string.tools_error_load)
    }

    suspend fun refreshWorkflows() = load(ToolSection.WORKFLOWS, workflows) { it.request("/workflow-runs?limit=25").let(::parseWorkflowRuns) }

    /** Appends the next page of workflow runs. */
    suspend fun moreWorkflows() {
        val cursor = workflows.value.nextCursor ?: return
        if (workflowsMore.loading || !permitted()) return
        val owner = fence()
        workflowsMore.loading = true
        try {
            val page = parseWorkflowRuns(api().request("/workflow-runs?limit=25&cursor=$cursor"))
            if (fence() == owner) workflows.value = page.copy(runs = (workflows.value.runs + page.runs).distinctBy { it.runId })
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (fence() == owner) report(failureText(e)) }
        finally { workflowsMore.loading = false }
    }

    suspend fun refreshSchedules() = load(ToolSection.SCHEDULES, schedules, apply = { fresh ->
        // A row with a request in flight keeps its optimistic state until that request settles.
        val inFlight = schedules.value.filter { it.pending }.associateBy { it.id }
        fresh.map { inFlight[it.id] ?: it }
    }) { parseSchedules(it.request("/schedules")) }

    /** Optimistic pause or resume with rollback: the row flips at once, the server's row replaces it, an error restores it. */
    fun setSchedulePaused(id: String, pause: Boolean) {
        val original = schedules.value.firstOrNull { it.id == id } ?: return
        if (!canToggleSchedule(original, "agent_messaging.manage" in capabilities()) || original.paused == pause) return
        val owner = fence()
        schedules.value = schedules.value.withPending(id, pause)
        scope.launch {
            try {
                val answer = api().request("/schedules/$id/${if (pause) "pause" else "resume"}", "POST", JSONObject().put("version", original.version))
                if (fence() != owner) return@launch
                val updated = answer.optJSONObject("schedule")?.let(::parseSchedule)
                schedules.value = if (updated != null) schedules.value.settled(updated) else schedules.value.reverted(original)
                report(texts.string(if (pause) R.string.tools_sched_paused_done else R.string.tools_sched_resumed_done, original.name))
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (fence() != owner) return@launch
                schedules.value = schedules.value.reverted(original)
                val status = (e as? ApiException)?.status
                report(status?.let { scheduleErrorRes(it, (e as ApiException).code) }?.let { texts.string(it) } ?: texts.string(R.string.tools_sched_error, e.message.orEmpty()))
                // A stale version means the list is outdated: reload it.
                if (status == 409) refreshSchedules()
            }
        }
    }

    suspend fun refreshGit() = load(ToolSection.GIT, git) { parseGitMerges(it.request("/git-director/merges")) }
    suspend fun refreshProjects() = load(ToolSection.PROJECTS, projects) { parseProjects(it.request("/projects")) }
    suspend fun openBoard(slug: String) {
        board.reset(null)
        load(ToolSection.PROJECTS, board, hideOn404 = false) { parseBoard(it.request("/projects/" + java.net.URLEncoder.encode(slug, "UTF-8").replace("+", "%20") + "/board")) }
    }

    /** Sends feedback; the same draft keeps its request id across retries so the server replays instead of duplicating. */
    fun submitFeedback(draft: FeedbackDraft, onSuccess: () -> Unit) {
        if (feedbackBusy || ToolSection.FEEDBACK !in sections()) return
        draft.problem()?.let { report(texts.string(it)); return }
        val attempt = feedbackAttempt(draft, feedbackPending).also { feedbackPending = it }
        val owner = fence()
        feedbackBusy = true
        scope.launch {
            try {
                val answer = api().request("/feedback", "POST", attempt.draft.body(attempt.clientRequestId))
                if (fence() != owner) return@launch
                feedbackPending = null
                report(texts.string(R.string.tools_fb_sent, answer.optJSONObject("feedback")?.optString("title")?.takeIf { it.isNotBlank() } ?: attempt.draft.title.trim()))
                onSuccess()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (fence() != owner) return@launch
                val status = (e as? ApiException)?.status
                if (!feedbackRetryKeepsId(status)) feedbackPending = null
                if (status == 404) unavailable = unavailable + ToolSection.FEEDBACK
                report(if (e is ApiException) texts.string(R.string.tools_fb_error_server, e.message.orEmpty()) else texts.string(R.string.tools_fb_error_network))
            } finally { feedbackBusy = false }
        }
    }
}
