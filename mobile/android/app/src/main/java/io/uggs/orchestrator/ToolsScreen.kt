package io.uggs.orchestrator

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

private enum class Tone { SUCCESS, WARNING, INFO, NEUTRAL }

@Composable private fun ToneChip(text: String, tone: Tone, modifier: Modifier = Modifier) {
    val (container, content) = when (tone) {
        Tone.SUCCESS -> MaterialTheme.status.successContainer to MaterialTheme.status.onSuccessContainer
        Tone.WARNING -> MaterialTheme.status.warningContainer to MaterialTheme.status.onWarningContainer
        Tone.INFO -> MaterialTheme.status.infoContainer to MaterialTheme.status.onInfoContainer
        Tone.NEUTRAL -> MaterialTheme.colorScheme.surfaceContainerHigh to MaterialTheme.colorScheme.onSurfaceVariant
    }
    StatusChip(text, container, content, modifier)
}

private fun sectionLabel(section: ToolSection) = when (section) {
    ToolSection.WORKFLOWS -> R.string.tools_workflows
    ToolSection.SCHEDULES -> R.string.tools_schedules
    ToolSection.GIT -> R.string.tools_git
    ToolSection.PROJECTS -> R.string.tools_projects
    ToolSection.FEEDBACK -> R.string.tools_feedback
}

/** The Tools destination: one tab per section the server offers and the operator may use. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun ToolsScreen(model: CompanionModel, fresh: Boolean) {
    val tools = model.tools
    val sections = tools.sections()
    var selected by rememberSaveable { mutableStateOf(ToolSection.WORKFLOWS.name) }
    val current = sections.firstOrNull { it.name == selected } ?: sections.firstOrNull()
    Column(Modifier.fillMaxSize().testTag("tools-screen")) {
        if (current == null) EmptyState(stringResource(R.string.tools_none), stringResource(R.string.tools_none_detail))
        else ToolsContent(model, fresh, sections, current) { selected = it.name }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun ColumnScope.ToolsContent(model: CompanionModel, fresh: Boolean, sections: List<ToolSection>, current: ToolSection, select: (ToolSection) -> Unit) {
    val tools = model.tools
    run {
        Text(stringResource(R.string.tools_title), Modifier.padding(start = 16.dp, top = 8.dp, end = 16.dp).semantics { heading() }, style = MaterialTheme.typography.headlineSmall)
        if (!fresh) Text(stringResource(R.string.tools_offline), Modifier.padding(horizontal = 16.dp, vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        PrimaryScrollableTabRow(selectedTabIndex = sections.indexOf(current), edgePadding = 8.dp) {
            sections.forEach { section ->
                Tab(selected = section == current, onClick = { select(section) }, text = { Text(stringResource(sectionLabel(section))) },
                    modifier = Modifier.heightIn(min = 48.dp).testTag("tools-tab:" + section.name.lowercase()))
            }
        }
        when (current) {
            ToolSection.WORKFLOWS -> WorkflowsPane(tools, fresh)
            ToolSection.SCHEDULES -> SchedulesPane(model, fresh)
            ToolSection.GIT -> GitPane(tools, fresh)
            ToolSection.PROJECTS -> ProjectsPane(tools, fresh)
            ToolSection.FEEDBACK -> FeedbackPane(tools)
        }
    }
}

/** Pull-to-refresh list with the shared loading, error and retry rows; [content] adds the items. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun ToolPane(state: Loadable<*>, fresh: Boolean, tag: String, onRefresh: suspend () -> Unit, content: LazyListScope.() -> Unit) {
    val scope = rememberCoroutineScope()
    LaunchedEffect(fresh) { if (fresh) onRefresh() }
    PullToRefreshBox(isRefreshing = state.loading && state.loaded, onRefresh = { scope.launch { onRefresh() } }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().testTag(tag), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            state.error?.let { message ->
                item(key = "error") {
                    Column {
                        Text(message, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = { scope.launch { onRefresh() } }, enabled = !state.loading, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.action_retry)) }
                    }
                }
            }
            if (!state.loaded && state.loading) item(key = "loading") { SkeletonCards(3) }
            content()
        }
    }
}

// Workflow runs

private fun workflowStatusRes(status: String) = when (status) {
    "pending" -> R.string.tools_wf_pending
    "running" -> R.string.tools_wf_running
    "paused" -> R.string.tools_wf_paused
    "blocked" -> R.string.tools_wf_blocked
    "evaluating" -> R.string.tools_wf_evaluating
    "completed" -> R.string.tools_wf_completed
    else -> null
}

@Composable private fun WorkflowsPane(tools: ToolsState, fresh: Boolean) {
    val page = tools.workflows.value
    val scope = rememberCoroutineScope()
    val t = rememberTexts()
    val uri = LocalUriHandler.current
    ToolPane(tools.workflows, fresh, "workflow-list", tools::refreshWorkflows) {
        if (tools.workflows.loaded && !page.enabled) item(key = "disabled") { EmptyState(stringResource(R.string.tools_wf_disabled)) }
        else if (tools.workflows.loaded && page.runs.isEmpty() && tools.workflows.error == null) item(key = "none") { EmptyState(stringResource(R.string.tools_wf_none)) }
        items(page.runs, key = { it.runId }) { run ->
            val link = safeReportUrl(run.reportUrl)
            OutlinedCard(Modifier.fillMaxWidth().testTag("workflow:" + run.runId)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(run.title, style = MaterialTheme.typography.titleMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        val tone = when (run.status) { "completed" -> Tone.SUCCESS; "blocked", "evaluating" -> Tone.WARNING; "running" -> Tone.INFO; else -> Tone.NEUTRAL }
                        ToneChip(workflowStatusRes(run.status)?.let { stringResource(it) } ?: run.status, tone)
                        when (run.awaitingDecision) {
                            "evaluation" -> ToneChip(stringResource(R.string.tools_wf_awaiting_evaluation), Tone.WARNING, Modifier.testTag("awaiting:" + run.runId))
                            "blocked" -> ToneChip(stringResource(R.string.tools_wf_awaiting_blocked), Tone.WARNING, Modifier.testTag("awaiting:" + run.runId))
                        }
                    }
                    run.summary?.let { Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 5, overflow = TextOverflow.Ellipsis) }
                    run.outcome?.let { Text(stringResource(R.string.tools_wf_outcome, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    run.openItems?.takeIf { it > 0 }?.let { Text(t.plural(R.plurals.tools_wf_open_items, it, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    toolsTime(t, run.updatedAt)?.let { Text(stringResource(R.string.quota_updated, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    if (link != null) OutlinedButton(onClick = { runCatching { uri.openUri(link) } }, modifier = Modifier.heightIn(min = 48.dp).testTag("open-report:" + run.runId)) { Text(stringResource(R.string.tools_wf_open_report)) }
                }
            }
        }
        if (page.nextCursor != null) item(key = "more") {
            TextButton(onClick = { scope.launch { tools.moreWorkflows() } }, enabled = !tools.workflowsMore.loading, modifier = Modifier.heightIn(min = 48.dp).testTag("workflows-more")) { Text(stringResource(R.string.tools_load_more)) }
        }
    }
}

// Schedules

@Composable private fun SchedulesPane(model: CompanionModel, fresh: Boolean) {
    val tools = model.tools
    val t = rememberTexts()
    val canManage = fresh && model.can("agent_messaging.manage")
    ToolPane(tools.schedules, fresh, "schedule-list", tools::refreshSchedules) {
        if (tools.schedules.loaded && tools.schedules.value.isEmpty() && tools.schedules.error == null) item(key = "none") { EmptyState(stringResource(R.string.tools_sched_none)) }
        items(tools.schedules.value, key = { it.id }) { item ->
            OutlinedCard(Modifier.fillMaxWidth().testTag("schedule:" + item.id)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(item.name, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                        if (item.paused) ToneChip(stringResource(R.string.tools_sched_paused), Tone.WARNING) else ToneChip(stringResource(R.string.tools_sched_active), Tone.SUCCESS)
                    }
                    Text(scheduleTiming(t, item), style = MaterialTheme.typography.bodyMedium)
                    if (!item.paused) toolsTime(t, item.nextRunAt)?.let { Text(stringResource(R.string.tools_sched_next, it), style = MaterialTheme.typography.bodySmall) }
                    if (item.paused) item.pauseReason?.let { Text(stringResource(R.string.tools_sched_pause_reason, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    item.lastStatus?.let { Text(stringResource(R.string.tools_sched_last, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    item.lastError?.let { Text(stringResource(R.string.tools_sched_last_error, it), Modifier.testTag("schedule-error:" + item.id), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                    if (model.can("agent_messaging.manage")) {
                        Button(
                            onClick = { tools.setSchedulePaused(item.id, pause = !item.paused) },
                            enabled = canManage && canToggleSchedule(item, true),
                            modifier = Modifier.heightIn(min = 48.dp).testTag("schedule-toggle:" + item.id),
                        ) {
                            if (item.pending) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                            else Text(stringResource(if (item.paused) R.string.tools_sched_resume else R.string.tools_sched_pause))
                        }
                    }
                }
            }
        }
    }
}

// Git Director

@Composable private fun GitPane(tools: ToolsState, fresh: Boolean) {
    val page = tools.git.value
    val t = rememberTexts()
    ToolPane(tools.git, fresh, "git-list", tools::refreshGit) {
        if (tools.git.loaded && !page.enabled) item(key = "disabled") { EmptyState(stringResource(R.string.tools_git_disabled)) }
        else if (tools.git.loaded && page.merges.isEmpty() && tools.git.error == null) item(key = "none") { EmptyState(stringResource(R.string.tools_git_none)) }
        items(page.merges, key = { it.requestId }) { merge ->
            OutlinedCard(Modifier.fillMaxWidth().testTag("merge:" + merge.requestId)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(merge.repo ?: merge.host ?: merge.requestId, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (merge.status == "allowed") ToneChip(stringResource(R.string.tools_git_allowed), Tone.SUCCESS) else ToneChip(stringResource(R.string.tools_git_waiting), Tone.WARNING)
                    }
                    if (merge.branch != null || merge.targetBranch != null) Text(stringResource(R.string.tools_git_branch, merge.branch ?: "?", merge.targetBranch ?: "?"), style = MaterialTheme.typography.bodyMedium)
                    merge.host?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    merge.task?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                    merge.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    mergeAge(t, merge.ageSeconds)?.let { Text(stringResource(R.string.tools_git_age, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        }
    }
}

// Projects

@Composable private fun ProjectsPane(tools: ToolsState, fresh: Boolean) {
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    BackHandler(enabled = open != null) { open = null }
    val slug = open
    if (slug == null) {
        val list = tools.projects.value
        ToolPane(tools.projects, fresh, "project-list", tools::refreshProjects) {
            if (tools.projects.loaded && !list.boardEnabled) item(key = "disabled") { EmptyState(stringResource(R.string.tools_projects_board_disabled)) }
            else if (tools.projects.loaded && list.projects.isEmpty() && tools.projects.error == null) item(key = "none") { EmptyState(stringResource(R.string.tools_projects_none)) }
            else if (list.boardEnabled) items(list.projects, key = { it.slug }) { project ->
                OutlinedCard(onClick = { open = project.slug; scope.launch { tools.openBoard(project.slug) } }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("project:" + project.slug)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(project.title, style = MaterialTheme.typography.titleMedium)
                        if (project.description.isNotBlank()) Text(project.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    } else {
        LaunchedEffect(slug) { if (!tools.board.loaded && !tools.board.loading) tools.openBoard(slug) }
        BoardView(tools, slug, onBack = { open = null }) { scope.launch { tools.openBoard(slug) } }
    }
}

private fun cardStatusRes(status: String) = when (status) {
    "blocked" -> R.string.tools_card_blocked
    "claimed" -> R.string.tools_card_claimed
    "waiting" -> R.string.tools_card_waiting
    else -> null
}

@Composable private fun BoardView(tools: ToolsState, slug: String, onBack: () -> Unit, reload: () -> Unit) {
    val board = tools.board.value
    val t = rememberTexts()
    LazyColumn(Modifier.fillMaxSize().testTag("board"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item(key = "head") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack, modifier = Modifier.size(48.dp).testTag("board-back")) { CompanionIcon(CompanionSymbol.Back, stringResource(R.string.cd_back)) }
                Text(board?.title ?: slug, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleLarge)
            }
        }
        tools.board.error?.let { message ->
            item(key = "error") {
                Column { Text(message, color = MaterialTheme.colorScheme.error); TextButton(onClick = reload, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.action_retry)) } }
            }
        }
        if (tools.board.loading && board == null) item(key = "loading") { SkeletonCards(3) }
        board?.columns?.forEach { column ->
            item(key = "col:" + column.id) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionHeader(column.title, column.cardCount, Modifier.weight(1f))
                    column.wipLimit?.let { limit -> if (column.overWip) ToneChip(stringResource(R.string.tools_col_over_wip, limit), Tone.WARNING) else Text(stringResource(R.string.tools_col_wip, limit), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
            if (column.cards.isEmpty()) item(key = "col-empty:" + column.id) { Text(stringResource(R.string.tools_col_empty), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(column.cards, key = { "card:" + column.id + ":" + it.id }) { card ->
                OutlinedCard(Modifier.fillMaxWidth().testTag("card:" + card.id)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(listOfNotNull(card.number?.let { "#$it" }, card.title).joinToString(" "), style = MaterialTheme.typography.titleSmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            cardStatusRes(card.status)?.let { ToneChip(stringResource(it), if (card.status == "blocked") Tone.WARNING else Tone.NEUTRAL) }
                            card.priority?.let { Text(stringResource(R.string.tools_card_priority, it), style = MaterialTheme.typography.labelMedium) }
                        }
                        card.blockedReason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                        card.assignee?.let { Text(stringResource(R.string.tools_card_assignee, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        toolsTime(t, card.dueAt)?.let { Text(stringResource(R.string.tools_card_due, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        if (card.labels.isNotEmpty()) Text(card.labels.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (column.truncated) item(key = "col-more:" + column.id) { Text(stringResource(R.string.tools_col_truncated, column.cardCount), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

// Feedback

private fun feedbackTypeRes(type: String) = when (type) { "bug" -> R.string.tools_fb_type_bug; "feature" -> R.string.tools_fb_type_feature; else -> R.string.tools_fb_type_feedback }
private fun feedbackPriorityRes(priority: String) = when (priority) { "low" -> R.string.tools_fb_prio_low; "high" -> R.string.tools_fb_prio_high; "critical" -> R.string.tools_fb_prio_critical; else -> R.string.tools_fb_prio_normal }

@OptIn(ExperimentalLayoutApi::class)
@Composable private fun FeedbackPane(tools: ToolsState) {
    var type by rememberSaveable { mutableStateOf("bug") }
    var title by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var component by rememberSaveable { mutableStateOf("") }
    var priority by rememberSaveable { mutableStateOf<String?>(null) }
    val draft = FeedbackDraft(type, title, description, component, priority)
    val enabled = !tools.feedbackBusy
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(16.dp).testTag("feedback-form"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.tools_fb_intro), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(stringResource(R.string.tools_fb_type), style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FEEDBACK_TYPES.forEach { value -> FilterChip(selected = type == value, onClick = { type = value }, enabled = enabled, label = { Text(stringResource(feedbackTypeRes(value))) }, modifier = Modifier.heightIn(min = 48.dp).testTag("fb-type:$value")) }
        }
        OutlinedTextField(title, { title = it.take(FEEDBACK_TITLE_MAX) }, label = { Text(stringResource(R.string.tools_fb_title)) }, modifier = Modifier.fillMaxWidth().testTag("fb-title"), singleLine = true, enabled = enabled)
        OutlinedTextField(description, { description = it.take(FEEDBACK_DESCRIPTION_MAX) }, label = { Text(stringResource(R.string.tools_fb_description)) }, modifier = Modifier.fillMaxWidth().testTag("fb-description"), minLines = 4, maxLines = 10, enabled = enabled)
        OutlinedTextField(component, { component = it.take(FEEDBACK_COMPONENT_MAX) }, label = { Text(stringResource(R.string.tools_fb_component)) }, supportingText = { Text(stringResource(R.string.tools_fb_component_hint)) }, modifier = Modifier.fillMaxWidth().testTag("fb-component"), singleLine = true, enabled = enabled)
        Text(stringResource(R.string.tools_fb_priority), style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = priority == null, onClick = { priority = null }, enabled = enabled, label = { Text(stringResource(R.string.tools_fb_prio_default)) }, modifier = Modifier.heightIn(min = 48.dp))
            FEEDBACK_PRIORITIES.forEach { value -> FilterChip(selected = priority == value, onClick = { priority = value }, enabled = enabled, label = { Text(stringResource(feedbackPriorityRes(value))) }, modifier = Modifier.heightIn(min = 48.dp).testTag("fb-prio:$value")) }
        }
        Text(stringResource(R.string.tools_fb_text_only), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(
            onClick = { tools.submitFeedback(draft) { title = ""; description = ""; component = ""; priority = null; type = "bug" } },
            enabled = enabled && draft.problem() == null, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("fb-send"),
        ) {
            if (tools.feedbackBusy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.tools_fb_send))
        }
    }
}

/** The Tools entry of the More sheet. */
@Composable internal fun ToolsEntry(onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("more-tools")) { Text(stringResource(R.string.tools_open)) }
}
