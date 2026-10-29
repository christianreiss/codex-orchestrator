package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId

class ToolsModelsTest {
    private val utc = ZoneId.of("UTC")

    @Test fun flagsAreReadPerFeatureAndMissingMeansHidden() {
        assertEquals(ToolsFlags.NONE, ToolsFlags.from(JSONObject("{}")))
        val flags = ToolsFlags.from(JSONObject("""{"workflows_protocol":1,"schedules_protocol":1,"feedback_protocol":1,"remote_stop_protocol":1}"""))
        assertTrue(flags.workflows && flags.schedules && flags.feedback && flags.remoteStop)
        assertFalse(flags.git || flags.projects || flags.permissionMode || flags.quotaPush)
    }

    @Test fun sectionsNeedFlagCapabilityAndNoEarlier404() {
        val flags = ToolsFlags(workflows = true, schedules = true, git = true, projects = true, feedback = true)
        val caps = setOf("workflows.read", "agent_messaging.read", "git_director.read", "projects.read")
        assertEquals(listOf(ToolSection.WORKFLOWS, ToolSection.SCHEDULES, ToolSection.GIT, ToolSection.PROJECTS), availableToolSections(flags, caps))
        assertEquals(listOf(ToolSection.WORKFLOWS, ToolSection.GIT, ToolSection.PROJECTS), availableToolSections(flags, caps, setOf(ToolSection.SCHEDULES)))
        assertTrue(availableToolSections(ToolsFlags.NONE, caps + "feedback.manage").isEmpty())
    }

    @Test fun workflowRunsParseWithAwaitingDecisionAndCursor() {
        val page = parseWorkflowRuns(JSONObject("""{"enabled":true,"runs":[
            {"run_id":"r1","title":"Deploy","status":"evaluating","outcome":null,"summary":"All green","report_url":"https://x/report","open_items":2,"awaiting_decision":"evaluation","updated_at":"2026-10-29T10:00:00Z"},
            {"run_id":"r2","title":"","status":"blocked","awaiting_decision":"blocked"},
            {"title":"no id"}],"next_cursor":25}"""))
        assertEquals(2, page.runs.size)
        assertEquals("evaluation", page.runs[0].awaitingDecision)
        assertNull(page.runs[0].outcome)
        assertEquals(2, page.runs[0].openItems)
        assertEquals("r2", page.runs[1].title)
        assertEquals(25, page.nextCursor)
        assertNull(parseWorkflowRuns(JSONObject("""{"runs":[],"next_cursor":null}""")).nextCursor)
    }

    @Test fun reportUrlsMustBeWebLinks() {
        assertEquals("https://a/b", safeReportUrl(" https://a/b "))
        assertEquals("http://a", safeReportUrl("http://a"))
        assertNull(safeReportUrl("javascript:alert(1)"))
        assertNull(safeReportUrl("intent://x#Intent;end"))
        assertNull(safeReportUrl("file:///etc/passwd"))
        assertNull(safeReportUrl(null))
    }

    private fun schedule(id: String = "s1", enabled: Boolean = true, version: Long = 3) = JSONObject("""{"id":"$id","name":"Nightly","target":"agent","kind":"cron","cron":"0 3 * * *","timezone":"UTC",
        "enabled":$enabled,"paused":${!enabled},"next_run_at":"2026-10-30T03:00:00Z","version":$version,"last_run":{"status":"failed","last_error":"boom"},"last_error":"boom"}""")

    @Test fun schedulesParseLastErrorAndVersion() {
        val items = parseSchedules(JSONObject().put("schedules", JSONArray().put(schedule()).put(schedule("s2", enabled = false))))
        assertEquals(3L, items[0].version)
        assertEquals("boom", items[0].lastError)
        assertEquals("failed", items[0].lastStatus)
        assertTrue(items[1].paused)
    }

    @Test fun optimisticPauseFlipsTheRowAndRollbackRestoresIt() {
        val original = parseSchedule(schedule())!!
        val other = parseSchedule(schedule("s2"))!!
        val list = listOf(original, other)
        val pending = list.withPending("s1", pause = true)
        assertTrue(pending[0].paused && pending[0].pending)
        assertNull(pending[0].nextRunAt)
        assertEquals(other, pending[1])
        assertFalse(canToggleSchedule(pending[0], canManage = true))
        assertEquals(list, pending.reverted(original))
        assertTrue(canToggleSchedule(original, true))
        assertFalse(canToggleSchedule(original, false))
    }

    @Test fun serverRowReplacesTheOptimisticOne() {
        val original = parseSchedule(schedule())!!
        val pending = listOf(original).withPending("s1", true)
        val answered = parseSchedule(schedule(enabled = false, version = 4))!!
        val settled = pending.settled(answered)
        assertEquals(4L, settled[0].version)
        assertFalse(settled[0].pending)
        assertTrue(settled[0].paused)
    }

    @Test fun scheduleErrorsMapToMessages() {
        assertEquals(R.string.tools_sched_conflict, scheduleErrorRes(409, "schedule_version_conflict"))
        assertEquals(R.string.tools_sched_watchdog, scheduleErrorRes(403, "watchdog_schedule_managed"))
        assertEquals(R.string.tools_sched_forbidden, scheduleErrorRes(403, null))
        assertNull(scheduleErrorRes(500, null))
    }

    @Test fun scheduleTimingReadsEnglish() {
        val cron = parseSchedule(schedule())!!
        assertEquals("Cron 0 3 * * * (UTC)", scheduleTiming(TestTexts, cron, utc))
        val interval = cron.copy(kind = "interval", intervalMinutes = 15)
        assertEquals("Every 15 minutes", scheduleTiming(TestTexts, interval, utc))
        assertEquals("Once, 30 Oct, 03:00", scheduleTiming(TestTexts, cron.copy(kind = "once", at = "2026-10-30T03:00:00Z"), utc))
    }

    @Test fun gitMergesParse() {
        val page = parseGitMerges(JSONObject("""{"enabled":true,"merges":[{"request_id":"m1","status":"waiting","repo":"git@x:y.git","host":"h","target_branch":"main","branch":"task/a","agent":{"engine":"claude","task":"fix"},"age_seconds":125}]}"""))
        assertEquals("waiting", page.merges[0].status)
        assertEquals("fix", page.merges[0].task)
        assertEquals("2 min", mergeAge(TestTexts, page.merges[0].ageSeconds))
        assertEquals("45 s", mergeAge(TestTexts, 45))
        assertFalse(parseGitMerges(JSONObject("""{"enabled":false,"merges":[]}""")).enabled)
    }

    @Test fun projectsAndBoardParse() {
        val list = parseProjects(JSONObject("""{"board_enabled":true,"projects":[{"slug":"a","title":"Alpha","description":"d"},{"title":"x"}]}"""))
        assertEquals(1, list.projects.size)
        assertEquals("Alpha", list.projects[0].title)
        val board = parseBoard(JSONObject("""{"project":{"title":"Alpha"},"columns":[{"id":"c1","key":"todo","title":"To do","card_count":5,"wip_limit":3,"over_wip":true,"truncated":true,
            "cards":[{"id":"k1","number":7,"title":"Card","labels":["a","b"],"priority":"high","status":"claimed","assignee":{"username":"bob","host":"h1"},"blocked_reason":null},{"title":"no id"}]}]}"""))
        assertEquals("Alpha", board.title)
        val column = board.columns.single()
        assertTrue(column.overWip && column.truncated)
        assertEquals(3, column.wipLimit)
        val card = column.cards.single()
        assertEquals(7L, card.number)
        assertEquals("bob@h1", card.assignee)
        assertEquals(listOf("a", "b"), card.labels)
        assertNull(card.blockedReason)
    }

    @Test fun feedbackDraftValidatesAndBuildsTheBody() {
        assertNotNull(FeedbackDraft("bug", " ", "d").problem())
        assertNotNull(FeedbackDraft("bug", "t", "  ").problem())
        assertNotNull(FeedbackDraft("nope", "t", "d").problem())
        assertNotNull(FeedbackDraft("bug", "t", "d", priority = "urgent").problem())
        assertNotNull(FeedbackDraft("bug", "x".repeat(256), "d").problem())
        val ok = FeedbackDraft("feature", " Title ", " Body ", " dashboard ", "high")
        assertNull(ok.problem())
        val body = ok.body("11111111-1111-1111-1111-111111111111")
        assertEquals("Title", body.getString("title"))
        assertEquals("dashboard", body.getString("component"))
        assertEquals("high", body.getString("priority"))
        val minimal = FeedbackDraft("bug", "t", "d").body("id")
        assertFalse(minimal.has("component") || minimal.has("priority"))
    }

    @Test fun feedbackRequestIdIsReusedOnlyForAnUnchangedDraft() {
        var n = 0
        val ids = { "id-${++n}" }
        val draft = FeedbackDraft("bug", "t", "d")
        val first = feedbackAttempt(draft, null, ids)
        assertEquals(first, feedbackAttempt(draft, first, ids))
        assertEquals("id-1", feedbackAttempt(draft.copy(), first, ids).clientRequestId)
        assertEquals("id-2", feedbackAttempt(draft.copy(title = "other"), first, ids).clientRequestId)
        assertTrue(feedbackRetryKeepsId(null))
        assertTrue(feedbackRetryKeepsId(503))
        assertFalse(feedbackRetryKeepsId(422))
        assertFalse(feedbackRetryKeepsId(409))
    }

    private fun host(modes: String) = JSONObject("""{"host_id":1,"engines":["codex","claude","grok"],"permission_modes":$modes}""")

    @Test fun planIsOfferedOnlyWhereTheHostListsIt() {
        val h = host("""{"codex":["default"],"claude":["default","plan"],"grok":["default"]}""")
        assertEquals(PlanAvailability.ENGINE_UNSUPPORTED, planAvailability(h, "codex"))
        assertEquals(PlanAvailability.OFFERED, planAvailability(h, "claude"))
        assertEquals(PlanAvailability.HOST_UNSUPPORTED, planAvailability(h, "grok"))
        assertEquals(PlanAvailability.HOST_UNSUPPORTED, planAvailability(JSONObject("""{"engines":["claude"]}"""), "claude"))
    }

    @Test fun planStartNeedsATaskAndOnlyPlanSendsTheMode() {
        assertEquals(R.string.start_plan_needs_task, planStartProblem(true, "  "))
        assertNull(planStartProblem(true, "do it"))
        assertNull(planStartProblem(false, ""))
        assertEquals("plan", startBody(1, "claude", " task ", "", "", true, "u").getString("permission_mode"))
        val plain = startBody(1, "codex", "task", "t", "/srv", false, "u")
        assertFalse(plain.has("permission_mode"))
        assertEquals("/srv", plain.getString("cwd"))
        assertEquals(R.string.plan_error_engine, planStartErrorRes(422, "permission_mode_engine_unsupported"))
        assertEquals(R.string.plan_error_host, planStartErrorRes(409, "permission_mode_unsupported"))
        assertNull(planStartErrorRes(422, "validation_failed"))
    }

    private fun session(mode: String = "plan", status: String = "idle", prompt: String? = null) = JSONObject().put("id", "s").put("daemon_session", true)
        .put("permission_mode", mode).put("remote_status", status).apply { prompt?.let { put("pending_prompt", JSONObject(it)) } }
    private val manage = setOf("agent_messaging.manage", "agent_portal.manage", "agent_portal.reveal_transcript")

    @Test fun planBannerVisibilityFollowsModeStatusAndPermissions() {
        assertEquals(PlanBanner.HIDDEN, planBanner(null, manage, true))
        assertEquals(PlanBanner.HIDDEN, planBanner(session(mode = "default"), manage, true))
        assertEquals(PlanBanner.HIDDEN, planBanner(session(status = "closed"), manage, true))
        assertEquals(PlanBanner.HIDDEN, planBanner(JSONObject().put("permission_mode", "plan"), manage, true))
        assertEquals(PlanBanner.READY, planBanner(session(), manage, true))
        assertEquals(PlanBanner.READY, planBanner(session(status = "waiting"), manage, true))
        assertEquals(PlanBanner.WORKING, planBanner(session(status = "running"), manage, true))
        assertEquals(PlanBanner.WORKING, planBanner(session(), manage, false))
        assertEquals(PlanBanner.WORKING, planBanner(session(), manage, true, busy = true))
        assertEquals(PlanBanner.WORKING, planBanner(session(), manage - "agent_portal.manage", true))
    }

    @Test fun planPromptIsAnsweredOnlyWhenItOffersApprove() {
        val plan = """{"id":"p1","question":"Plan?","choices":[{"label":"Approve","value":"approve"},{"label":"Reject","value":"reject"}]}"""
        assertEquals("p1", planPromptId(session(prompt = plan)))
        assertNull(planPromptId(session(prompt = """{"id":"p2","choices":[{"label":"Yes","value":"yes"}]}""")))
        assertNull(planPromptId(session()))
        val body = planApprovalBody("uuid", "p1")
        assertEquals("default", body.getString("mode"))
        assertEquals("uuid", body.getString("client_message_id"))
        assertEquals("p1", body.getString("prompt_id"))
        assertFalse(planApprovalBody("uuid", null).has("prompt_id"))
    }

    @Test fun planApprovalIdIsStablePerTapAndDroppedAfterADefiniteAnswer() {
        var n = 0
        val approvals = PlanApprovals { "id-${++n}" }
        assertEquals("id-1", approvals.idFor("s"))
        assertEquals("id-1", approvals.idFor("s"))
        approvals.settle("s", null)
        assertEquals("id-1", approvals.idFor("s"))
        approvals.settle("s", 503)
        assertEquals("id-1", approvals.idFor("s"))
        approvals.settle("s", 409)
        assertEquals("id-2", approvals.idFor("s"))
        approvals.done("s")
        assertEquals("id-3", approvals.idFor("s"))
        assertEquals(R.string.plan_approve_conflict, planApprovalErrorRes(409, null))
        assertEquals(R.string.plan_approve_rejected, planApprovalErrorRes(422, null))
        assertNull(planApprovalErrorRes(500, null))
    }

    @Test fun stopIsOfferedForLiveOwnRemoteSessions() {
        val flags = ToolsFlags(remoteStop = true)
        assertTrue(canStopSession(session(status = "running"), flags, manage, true))
        assertFalse(canStopSession(session(status = "closed"), flags, manage, true))
        assertFalse(canStopSession(session(status = "stopping"), flags, manage, true))
        assertFalse(canStopSession(session(), ToolsFlags.NONE, manage, true))
        assertFalse(canStopSession(session(), flags, emptySet(), true))
        assertFalse(canStopSession(session(), flags, manage, false))
        assertFalse(canStopSession(JSONObject().put("remote_status", "idle"), flags, manage, true))
    }

    private fun quotaData(vararg extra: Pair<String, String>) = mapOf("kind" to "quota", "notification_id" to "n1", "device_id" to "d", "target_id" to "acc-1", "engine" to "claude",
        "account_id" to "acc-1", "account_label" to "Work", "window" to "weekly", "used_percent" to "87.4", "threshold" to "85", "resets_at" to "2026-11-03T14:00:00Z",
        "conversation_key" to "quota:claude", "summary" to "Quota warning") + extra

    @Test fun quotaPushParsesAndRenders() {
        val push = parseQuotaPush(quotaData())!!
        assertEquals("claude", push.engine)
        assertEquals(87.4, push.usedPercent!!, 0.001)
        assertEquals(85, push.threshold)
        assertEquals("Claude quota warning", quotaPushTitle(TestTexts, push))
        assertEquals("Weekly: 87% used · Resets 3 Nov, 14:00", quotaPushText(TestTexts, push, utc))
        assertEquals("quota:scope:claude:acc-1:weekly", quotaNotificationTag("scope", push))
    }

    @Test fun quotaPushToleratesMissingOptionalFieldsAndRejectsMalformed() {
        val sparse = parseQuotaPush(quotaData("used_percent" to "", "resets_at" to "garbage", "window" to "monthly"))!!
        assertNull(sparse.usedPercent)
        assertNull(sparse.resetsAt)
        assertEquals("Monthly", quotaPushText(TestTexts, sparse, utc))
        assertNull(parseQuotaPush(quotaData("kind" to "reply")))
        assertNull(parseQuotaPush(quotaData("notification_id" to " ")))
        assertNull(parseQuotaPush(quotaData("engine" to "")))
        assertNull(parseQuotaPush(quotaData("used_percent" to "NaN"))!!.usedPercent)
    }

    @Test fun quotaPushRoutesToTheQuotasTab() {
        assertEquals("quotas", Routes.QUOTAS)
        assertEquals("tools", Routes.TOOLS)
    }
}
