package io.uggs.orchestrator

import android.Manifest
import android.app.NotificationManager
import androidx.lifecycle.Lifecycle
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.Response
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.*
import org.junit.runner.RunWith
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class CompanionUiTest {
    @Test fun androidJsonNullNamesFallBackToSessionIdentity() {
        val unnamed = JSONObject("""{"session_name":null,"upstream_session_id":"33333333-cccc","id":"11111111-aaaa"}""")
        Assert.assertEquals("Session 33333333", agentTitle(unnamed))
        unnamed.put("upstream_session_id", JSONObject.NULL)
        Assert.assertEquals("Session 11111111", agentTitle(unnamed))
        unnamed.put("id", JSONObject.NULL)
        Assert.assertEquals("Unnamed session", agentTitle(unnamed))
    }

    @get:Rule val compose = createEmptyComposeRule()
    private val server = MockWebServer()
    private lateinit var scenario: ActivityScenario<MainActivity>
    private lateinit var originalClient: OkHttpClient
    private var firebase: JSONObject? = null
    private val registeredToken = AtomicReference<String?>(null)
    private val approved = AtomicBoolean(false)
    private val questionPending = AtomicBoolean(false)
    private val reachable = AtomicBoolean(true)
    private val readOnly = AtomicBoolean(false)
    private val presence = AtomicReference("listening")
    private val sessionListed = AtomicBoolean(true)
    private val networkAvailable = AtomicBoolean(true)
    private val transcriptAllowed = AtomicBoolean(true)
    private val holdMe = AtomicBoolean(false)
    private val meRequested = AtomicBoolean(false)
    private val holdTranscript = AtomicBoolean(false)
    private val transcriptRequested = AtomicBoolean(false)
    private val agentsRequested = AtomicLong(0)
    private val answered = AtomicReference<String?>(null)
    private var expiresAt = Instant.now().plusSeconds(120)
    private val sent = AtomicReference<String?>(null)
    private val live = AtomicReference<WebSocket?>(null)
    private val summary = AtomicReference("Ready for your message.")
    private val reply = AtomicReference("Ready for your message.")
    private val cursor = AtomicLong(1)
    private val history = CopyOnWriteArrayList<JSONObject>()
    private val extraAgents = CopyOnWriteArrayList<JSONObject>()
    private val cursorsRequested = CopyOnWriteArrayList<Long>()
    private val heartbeat = Executors.newSingleThreadScheduledExecutor()
    private val session = "68e117f3-e14b-4b86-a4c0-79808bf142c4"
    private val fixtureArgs = InstrumentationRegistry.getArguments()
    private val fixtureEngine = fixtureArgs.getString("fixtureEngine", "codex")!!
    private val fixtureHost = fixtureArgs.getString("fixtureHost", "lab.uggs.io")!!
    private val fixtureProject = fixtureArgs.getString("fixtureProject", "project")!!
    @Before fun setup() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        if (InstrumentationRegistry.getArguments().getString("firebase") == "true") {
            val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("cat /data/local/tmp/companion-google-services.json")
            val raw = android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { String(it.readBytes()) }
            val config = JSONObject(raw)
            val client = config.getJSONArray("client").objects().first { it.getJSONObject("client_info").getJSONObject("android_client_info").getString("package_name") == "io.uggs.orchestrator" }
            firebase = JSONObject().put("project_id", config.getJSONObject("project_info").getString("project_id"))
                .put("sender_id", config.getJSONObject("project_info").getString("project_number"))
                .put("app_id", client.getJSONObject("client_info").getString("mobilesdk_app_id"))
                .put("api_key", client.getJSONArray("api_key").getJSONObject(0).getString("current_key"))
        }
        val cert = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        server.useHttps(serverTls.sslSocketFactory(), false)
        originalClient = Api.client
        Api.client = originalClient.newBuilder().sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager).build()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.getHeader("Authorization") != "Bearer ${"a".repeat(64)}") return MockResponse().setResponseCode(401)
                if (!networkAvailable.get()) return MockResponse().setResponseCode(503)
                val path = request.path!!.substringBefore('?').removePrefix("/companion/v1")
                if (path == "/ws") return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) { live.set(webSocket); webSocket.send("""{"type":"hello"}""") }
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { live.compareAndSet(webSocket, null) }
                })
                val body = when {
                    path == "/me" -> {
                        meRequested.set(true)
                        while (holdMe.get()) Thread.sleep(20)
                        val capabilities = mutableListOf("agent_portal.read", "agent_portal.manage", "hosts.activate_insecure")
                        if (transcriptAllowed.get()) capabilities.add("agent_portal.reveal_transcript")
                        """{"device_id":"test-device","name":"Operator","capabilities":${org.json.JSONArray(capabilities)},"notifications":true,"follows":[],"firebase":${firebase ?: "null"}}"""
                    }
                    path == "/device" && request.method == "PATCH" -> {
                        val body = JSONObject(request.body.readUtf8())
                        if (body.has("fcm_token")) registeredToken.set(body.getString("fcm_token"))
                        "{}"
                    }
                    path == "/agents" -> {
                        agentsRequested.incrementAndGet()
                        val assistantCursor = if (history.isEmpty()) cursor.get() else history.filter { it.optString("type") == "assistant_message" }.maxOfOrNull { it.getLong("cursor") } ?: 0
                        val readCursors = if (request.method == "POST") JSONObject(request.body.readUtf8()).optJSONObject("read_cursors") else null
                        val readCursor = readCursors?.optLong(session) ?: 0
                        val unreadReplies = if (history.isEmpty()) if (cursor.get() > readCursor) 1 else 0 else history.count { it.optString("type") == "assistant_message" && it.getLong("cursor") > readCursor }
                        val preview = if (transcriptAllowed.get()) """{"summary":${JSONObject.quote(if (questionPending.get()) "Choose a target." else summary.get())},"created_at":"2026-10-07T19:00:00Z"}""" else "null"
                        val replyCursor = if (transcriptAllowed.get()) assistantCursor.toString() else "null"
                        val unreadCount = if (transcriptAllowed.get()) unreadReplies.toString() else "null"
                        val emptyCursor = if (transcriptAllowed.get()) "0" else "null"
                        val primary = if (!sessionListed.get()) "" else """{"id":"$session","session_name":${JSONObject.quote(fixtureProject)},"host":${JSONObject.quote(fixtureHost)},"engine":${JSONObject.quote(fixtureEngine)},"cwd":${JSONObject.quote("/work/$fixtureProject")},"presence":${JSONObject.quote(presence.get())},"read_only":${readOnly.get()},"relay_ready":${reachable.get()},"reply_cursor":$replyCursor,"unread_reply_count":$unreadCount,"preview":$preview,"pending_prompt":${if (transcriptAllowed.get() && questionPending.get()) """{"id":"question-1","version":1,"question":"Which target?","options":["Staging","Production"]}""" else "null"}},"""
                        val additional = extraAgents.joinToString("") { fixture ->
                            val agent = JSONObject(fixture.toString())
                            if (!transcriptAllowed.get()) {
                                agent.put("reply_cursor", JSONObject.NULL).put("unread_reply_count", JSONObject.NULL).put("preview", JSONObject.NULL)
                            } else if ((readCursors?.optLong(agent.getString("id")) ?: 0) >= agent.optLong("reply_cursor")) {
                                agent.put("unread_reply_count", 0)
                            }
                            "$agent,"
                        }
                        """{"agents":[$primary$additional{"id":"offline","host":"offline.uggs.io","cwd":"/old/offline-project","presence":"offline","relay_ready":false,"reply_cursor":$emptyCursor,"unread_reply_count":$emptyCursor},{"id":"idle","host":"idle.uggs.io","cwd":"/old/idle-project","presence":"idle","relay_ready":false,"reply_cursor":$emptyCursor,"unread_reply_count":$emptyCursor}]}"""
                    }
                    path == "/agents/$session/events" -> {
                        transcriptRequested.set(true)
                        while (holdTranscript.get()) Thread.sleep(20)
                        if (!transcriptAllowed.get()) return MockResponse().setResponseCode(403).setHeader("Content-Type", "application/json").setBody("""{"code":"capability_required","message":"Capability required"}""")
                        val after = request.requestUrl?.queryParameter("after")?.toLongOrNull() ?: -1
                        cursorsRequested.add(after)
                        val page = if (request.requestUrl?.queryParameter("tail") == "1") history.takeLast(250) else history.filter { it.getLong("cursor") > after }.take(250)
                        val rows = if (history.isNotEmpty()) page.joinToString(",") { it.toString() } else if (after >= cursor.get()) "" else """{"cursor":${cursor.get()},"type":"assistant_message","payload":{"text":${JSONObject.quote(reply.get())}}}"""
                        val next = if (history.isNotEmpty()) page.lastOrNull()?.getLong("cursor") ?: after.coerceAtLeast(0) else cursor.get()
                        """{"events":[$rows],"next_cursor":$next}"""
                    }
                    path == "/approvals" -> if (approved.get()) """{"requests":[],"default_duration_minutes":480}""" else """{"requests":[{"id":42,"fqdn":"waiting.uggs.io","request_ip":"192.0.2.42","live":true,"expires_at":"${expiresAt}"}],"default_duration_minutes":480}"""
                    path == "/approvals/42/approve" -> { approved.set(true); "{}" }
                    path == "/agents/$session/prompts/question-1/answer" -> { answered.set(JSONObject(request.body.readUtf8()).getString("answer")); questionPending.set(false); "{}" }
                    path == "/agents/$session/messages" -> {
                        val text = JSONObject(request.body.readUtf8()).getString("content"); sent.set(text)
                        if (history.isNotEmpty()) history.add(JSONObject().put("cursor", cursor.incrementAndGet()).put("type", "user_message").put("created_at", Instant.now().toString()).put("payload", JSONObject().put("text", text)))
                        "{}"
                    }
                    else -> "{}"
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody("{\"status\":\"ok\",\"data\":$body}")
            }
        }
        server.start()
        heartbeat.scheduleAtFixedRate({ live.get()?.send("""{"type":"ping"}""") }, 15, 15, TimeUnit.SECONDS)
        UnreadStore(context).clear()
        ConnectionStore(context).save(Connection(server.url("/").toString().trimEnd('/'), "a".repeat(64), "test-device", firebase))
        if (firebase != null) configurePush(context, ConnectionStore(context).load()!!)
        if (android.os.Build.VERSION.SDK_INT >= 33) InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }
    @After fun cleanup() {
        holdMe.set(false)
        holdTranscript.set(false)
        scenario.close()
        heartbeat.shutdownNow()
        live.getAndSet(null)?.close(1001, "Test finished")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        context.deleteFile("fcm-delivery-test.json")
        context.getSystemService(NotificationManager::class.java).cancelAll()
        ConnectionStore(context).clear()
        UnreadStore(context).clear()
        Api.client = originalClient
        server.shutdown()
    }
    @Test fun coldStartShowsConnectingUntilTheAuthorizedSnapshotArrives() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("Review next · 1").fetchSemanticsNodes().isNotEmpty() }
        scenario.close()
        holdMe.set(true); meRequested.set(false)
        val requestsBefore = agentsRequested.get()
        scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(10000) { meRequested.get() && compose.onAllNodesWithText("Loading your chats…").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Connecting…").assertIsDisplayed()
            compose.onNodeWithText("Loading your chats…").assertIsDisplayed()
            compose.onNodeWithText("Retry connection").assertDoesNotExist()
            compose.onNodeWithText("Reconnecting…").assertDoesNotExist()
            compose.onNodeWithText("Waiting for chats").assertDoesNotExist()
            compose.onNodeWithTag("agent:$session").assertDoesNotExist()
            compose.onNodeWithTag("approval:42").assertDoesNotExist()
            compose.onNodeWithText("Review next", substring = true).assertDoesNotExist()
            Assert.assertEquals("Chats wait for the current permission snapshot", requestsBefore, agentsRequested.get())
            compose.onNodeWithTag("chat-filter:unread").performClick()
            compose.onNodeWithText("Loading your chats…").assertIsDisplayed()
            compose.onNodeWithText("No unread chats").assertDoesNotExist()
            screenshot("startup-connecting")
        } finally { holdMe.set(false) }
        compose.waitUntil(15000) { compose.onAllNodesWithTag("agent:$session").fetchSemanticsNodes().isNotEmpty() && compose.onAllNodesWithText("Review next · 1").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("agent:$session").assertIsDisplayed()
        compose.onNodeWithText("Review next · 1").assertIsDisplayed()
        compose.onNodeWithText("Connecting…").assertDoesNotExist()
        compose.onNodeWithText("Loading your chats…").assertDoesNotExist()
        compose.onNodeWithText("Retry connection").assertDoesNotExist()
    }
    @Test fun failedColdStartShowsRetryAndRecoversWithoutPairingAgain() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("Review next · 1").fetchSemanticsNodes().isNotEmpty() }
        scenario.close()
        networkAvailable.set(false)
        scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(10000) { compose.onAllNodesWithText("Reconnecting…").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Reconnecting…").assertIsDisplayed()
            compose.onNodeWithText("Retry connection").assertIsDisplayed()
            compose.onNodeWithText("Connecting…").assertDoesNotExist()
            compose.onNodeWithText("Loading your chats…").assertDoesNotExist()
            compose.onNodeWithTag("agent:$session").assertDoesNotExist()
            compose.onNodeWithTag("approval:42").assertDoesNotExist()
            compose.onNodeWithText("Review next", substring = true).assertDoesNotExist()
            screenshot("startup-reconnecting")
            // Keep a background retry from completing before the explicit tap.
            holdMe.set(true)
            networkAvailable.set(true)
            compose.onNodeWithText("Retry connection").performClick()
        } finally { networkAvailable.set(true); holdMe.set(false) }
        compose.waitUntil(15000) { compose.onAllNodesWithTag("agent:$session").fetchSemanticsNodes().isNotEmpty() && compose.onAllNodesWithText("Review next · 1").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("agent:$session").assertIsDisplayed()
        compose.onNodeWithText("Review next · 1").assertIsDisplayed()
        compose.onNodeWithText("Reconnecting…").assertDoesNotExist()
        compose.onNodeWithText("Retry connection").assertDoesNotExist()
    }
    @Test fun firebaseRegistersWithSelectedProject() {
        Assume.assumeTrue("Run with -Pandroid.testInstrumentationRunnerArguments.firebase=true and the supplied config on the emulator", firebase != null)
        compose.waitUntil(60000) { registeredToken.get() != null }
        Assert.assertTrue(registeredToken.get()!!.length > 30)
    }
    @Test fun firebaseDeliversBackgroundApproval() {
        Assume.assumeTrue("Opt-in real FCM send from the host", firebase != null &&
            InstrumentationRegistry.getArguments().getString("firebaseDelivery") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        compose.waitUntil(60000) { registeredToken.get() != null }
        val id = java.util.UUID.randomUUID().toString()
        manager.cancelAll()
        scenario.moveToState(Lifecycle.State.CREATED)
        // Debug test bridge only: the host reads this private file with adb run-as.
        // Neither the service-account key nor OAuth bearer enters the emulator.
        context.openFileOutput("fcm-delivery-test.json", android.content.Context.MODE_PRIVATE).use {
            it.write(JSONObject().put("token", registeredToken.get()).put("notification_id", id).toString().toByteArray())
        }
        compose.waitUntil(90000) { manager.activeNotifications.any { it.id == id.hashCode() } }
        val notification = manager.activeNotifications.single { it.id == id.hashCode() }.notification
        Assert.assertEquals("Host access requested", notification.extras.getString("android.title"))
        Assert.assertFalse("A notification must not approve a request", approved.get())
        scenario.moveToState(Lifecycle.State.RESUMED)
        notification.contentIntent.send()
        compose.waitUntil(15000) { compose.onAllNodesWithText("Requesting IP: 192.0.2.42").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Requesting IP: 192.0.2.42").assertIsDisplayed()
        screenshot("live-push-review")
        Assert.assertFalse("Opening review must not approve a request", approved.get())
        compose.onNodeWithText("Allow 8h", useUnmergedTree = true).performClick()
        compose.waitUntil(10000) { approved.get() }
    }
    @Test fun chatAndReviewApproval() {
        compose.waitUntil(15000) { compose.onAllNodesWithText(fixtureProject).fetchSemanticsNodes().isNotEmpty() }
        screenshot("identity-list")
        compose.onNodeWithText(fixtureProject).performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText("Ready for your message.").fetchSemanticsNodes().isNotEmpty() }
        screenshot("identity-header")
        compose.onNodeWithText("INTERNAL_LIFECYCLE").assertDoesNotExist()
        compose.onNode(hasSetTextAction()).performClick().performTextInput("Please check the build")
        waitForKeyboard()
        screenshot("identity-keyboard")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.waitUntil(10000) { sent.get() != null }
        Assert.assertEquals("Please check the build", sent.get())
        screenshot("chat")
        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText("Review next · 1").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Review next · 1").performClick()
        compose.onNodeWithText("Requesting IP: 192.0.2.42").assertIsDisplayed()
        screenshot("approval")
        compose.onNodeWithText("Allow 8h", useUnmergedTree = true).performClick()
        compose.waitUntil(10000) { approved.get() }
        compose.waitUntil(10000) { compose.onAllNodesWithText("waiting.uggs.io").fetchSemanticsNodes().isEmpty() }
    }
    @Test fun onlyReachableAgentsAndDirectQuestionChoices() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("project").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("offline-project").assertDoesNotExist()
        compose.onNodeWithText("idle-project").assertDoesNotExist()
        questionPending.set(true)
        changed("agents")
        compose.waitUntil(3000) { compose.onAllNodesWithText("Choose a target.").fetchSemanticsNodes().isNotEmpty() }
        screenshot("now")
        compose.onNodeWithText("project").performClick()
        compose.onNodeWithText("Staging").performClick()
        compose.waitUntil(10000) { answered.get() != null }
        Assert.assertEquals("Staging", answered.get())
        Assert.assertNull("A choice uses the prompt answer endpoint", sent.get())
    }
    @Test fun sessionNamesDistinguishChatsSharingTheSameHostAndDirectory() {
        waitForAgentRows(session)
        extraAgents.add(agentFixture("name-review", "shared", "worker.example", "Checks passed.", "claude")
            .put("launch_name", "Claudia").put("task_title", "Release review").put("session_name", "(Claudia) Release review"))
        extraAgents.add(agentFixture("name-migration", "shared", "worker.example", "Schema prepared.", "grok")
            .put("launch_name", "Tanja").put("task_title", "Database migration").put("session_name", JSONObject.NULL))
        changed("agents")
        waitForAgentRows("name-review", "name-migration")
        compose.onNodeWithText("(Claudia) Release review").assertIsDisplayed()
        compose.onNodeWithText("(Tanja) Database migration").assertIsDisplayed()
        compose.onNode(hasText("/work/shared") and hasAnyAncestor(hasTestTag("agent:name-review")), useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("chat-search").performTextReplacement("Claudia")
        compose.onNodeWithTag("agent:name-review").assertIsDisplayed()
        compose.onNodeWithTag("agent:name-migration").assertDoesNotExist()
        Assert.assertFalse("Searching session names does not fetch a transcript", transcriptRequested.get())
        screenshot("session-names")
        compose.onNodeWithText("(Claudia) Release review").performClick()
        compose.onNodeWithText("(Claudia) Release review").assertIsDisplayed()
        screenshot("launch-name-chat")
    }
    @Test fun localChatSearchMatchesProjectFullHostAndSummaryWhileKeepingApprovalsPinned() {
        waitForAgentRows(session)
        extraAgents.add(agentFixture("search-payment", "payment-mobile", "edge-search.uggs.io", "Payment release reconciled.", "claude"))
        extraAgents.add(agentFixture("search-policy", "firewall-policy", "api-other.uggs.io", "Certificate chain verified.", "grok"))
        changed("agents")
        waitForAgentRows("search-payment", "search-policy")
        val ledger = unreadLedger()
        val requests = agentsRequested.get()

        compose.onNodeWithTag("chat-search").performTextReplacement("  PAYMENT-MOBILE  ")
        compose.onNodeWithTag("agent:search-payment").assertIsDisplayed()
        compose.onNodeWithTag("agent:search-policy").assertDoesNotExist()
        compose.onNodeWithTag("agent:$session").assertDoesNotExist()
        compose.onNodeWithText("waiting.uggs.io").assertIsDisplayed()

        compose.onNodeWithTag("chat-search").performTextReplacement("API-OTHER.UGGS.IO")
        compose.onNodeWithTag("agent:search-policy").assertIsDisplayed()
        compose.onNodeWithContentDescription("Host: api-other.uggs.io", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("agent:search-payment").assertDoesNotExist()

        compose.onNodeWithTag("chat-search").performTextReplacement("release RECONCILED")
        compose.onNodeWithText("Payment release reconciled.").assertIsDisplayed()
        compose.onNodeWithTag("agent:search-payment").assertIsDisplayed()
        compose.onNodeWithTag("agent:search-policy").assertDoesNotExist()

        compose.onNodeWithTag("chat-search").performTextReplacement("no such conversation")
        compose.onNodeWithTag("agent:search-payment").assertDoesNotExist()
        compose.onNodeWithTag("agent:search-policy").assertDoesNotExist()
        compose.onNodeWithTag("agent:$session").assertDoesNotExist()
        compose.onNodeWithText("waiting.uggs.io").assertIsDisplayed()
        compose.onNodeWithTag("chat-search").performTextReplacement("")
        waitForAgentRows(session, "search-payment", "search-policy")
        Assert.assertEquals("Local search does not request another agent snapshot", requests, agentsRequested.get())
        Assert.assertFalse("Searching does not load a transcript", transcriptRequested.get())
        Assert.assertEquals("Searching does not acknowledge an unread reply", ledger, unreadLedger())
        Assert.assertFalse("Pinned access requests remain undecided", approved.get())
        screenshot("chat-home-search")
    }
    @Test fun chatHomeRestoresSearchAndFilterAfterReadingAConversation() {
        waitForAgentRows(session)
        compose.onNodeWithTag("chat-search").performTextReplacement(" $fixtureProject ")
        compose.onNodeWithTag("chat-filter:unread").performClick()
        compose.onNodeWithTag("agent:$session").performClick()
        waitForUnread(emptySet())
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("chat-search").assertTextContains(" $fixtureProject ")
        compose.onNodeWithTag("chat-filter:unread").assertIsSelected()
        compose.onNodeWithText("No chats found").assertIsDisplayed()
        compose.onNodeWithTag("agent:$session").assertDoesNotExist()
        compose.onNodeWithText("Clear filters").performClick()
        compose.onNodeWithTag("agent:$session").assertIsDisplayed()
    }
    @Test fun chatFiltersIntersectSearchWithoutAcknowledgingRepliesAndKeepDecisionChoices() {
        waitForAgentRows(session)
        extraAgents.add(agentFixture("filter-unread", "release-check", "release.uggs.io", "Three checks need reading.", "claude", 30, 3))
        extraAgents.add(agentFixture("filter-read", "archive-check", "archive.uggs.io", "Already reviewed.", "grok"))
        changed("agents")
        waitForAgentRows("filter-unread", "filter-read")
        waitForUnread(setOf(session, "filter-unread"))
        val ledger = unreadLedger()
        val requests = agentsRequested.get()

        compose.onNodeWithTag("chat-filter:unread").performClick()
        compose.onNodeWithTag("agent:$session").assertIsDisplayed()
        compose.onNodeWithTag("agent:filter-unread").assertIsDisplayed()
        compose.onNodeWithTag("agent:filter-unread").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "3 unread replies"))
        compose.onNodeWithTag("agent:filter-read").assertDoesNotExist()
        compose.onNodeWithText("waiting.uggs.io").assertIsDisplayed()
        compose.onNodeWithTag("chat-search").performTextReplacement("release.uggs.io")
        compose.onNodeWithTag("agent:filter-unread").assertIsDisplayed()
        compose.onNodeWithTag("agent:$session").assertDoesNotExist()
        compose.onNodeWithTag("chat-search").performTextReplacement("")
        compose.onNodeWithTag("chat-filter:needs-you").performClick()
        compose.onNodeWithTag("agent:$session").assertDoesNotExist()
        compose.onNodeWithTag("agent:filter-unread").assertDoesNotExist()
        compose.onNodeWithText("waiting.uggs.io").assertIsDisplayed()
        Assert.assertEquals("Changing filters is local", requests, agentsRequested.get())
        Assert.assertFalse("Filtering does not load a transcript", transcriptRequested.get())
        Assert.assertEquals("Unread filters do not acknowledge replies", ledger, unreadLedger())

        questionPending.set(true)
        changed("agents")
        waitForAgentRows(session)
        compose.onNodeWithText("Choose a target.").assertIsDisplayed()
        compose.onNodeWithTag("agent:filter-unread").assertDoesNotExist()
        compose.onNodeWithText("waiting.uggs.io").assertIsDisplayed()
        Assert.assertEquals("An incoming decision does not acknowledge its reply", ledger, unreadLedger())
        compose.onNodeWithTag("chat-filter:all").performClick()
        waitForAgentRows(session, "filter-unread", "filter-read")
        compose.onNodeWithTag("chat-filter:needs-you").performClick()
        compose.onNodeWithText("Choose a target.").assertIsDisplayed()
        screenshot("chat-home-needs-you")
        compose.onNodeWithTag("agent:$session").performClick()
        compose.onNodeWithText("Staging").performClick()
        compose.waitUntil(10000) { answered.get() != null }
        Assert.assertEquals("Staging", answered.get())
        Assert.assertNull("Decision choices retain the prompt answer endpoint", sent.get())
        Assert.assertFalse("A chat decision cannot approve host access", approved.get())
    }
    @Test fun denseChatHomeKeepsFiveCompleteIdentitiesVisibleAndScrollsAtLargeFont() {
        waitForAgentRows(session)
        val projects = listOf("customer-portal", "billing-service", "inventory-api", "release-tools", "network-policy", "mobile-companion")
        projects.forEachIndexed { index, project ->
            extraAgents.add(agentFixture("dense-$index", project, "worker-${index + 1}.production.uggs.io", "Latest result for $project.", listOf("codex", "claude", "grok")[index % 3]))
        }
        changed("agents")
        waitForAgentRows(session, "dense-0")
        compose.onNodeWithText("Orchestrator").assertIsDisplayed()
        compose.onNodeWithTag("chat-search").assertIsDisplayed()
        compose.onNodeWithTag("chat-filter:all").assertIsSelected()
        compose.onNodeWithText("waiting.uggs.io").assertIsDisplayed()
        compose.onNodeWithTag("agent:$session").assertIsDisplayed()
        assertCompleteTitle(fixtureProject)
        compose.onNodeWithContentDescription("Host: $fixtureHost", useUnmergedTree = true).assertIsDisplayed()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        if (context.resources.configuration.fontScale <= 1.05f) {
            projects.take(4).forEachIndexed { index, project ->
                compose.onNodeWithTag("agent:dense-$index").assertIsDisplayed()
                assertCompleteTitle(project)
                compose.onNodeWithContentDescription("Host: worker-${index + 1}.production.uggs.io", useUnmergedTree = true).assertIsDisplayed()
            }
        }
        screenshot("chat-home-dense")
        compose.onNodeWithTag("chat-list").performScrollToIndex(projects.size + 1)
        compose.onNodeWithTag("agent:dense-5").assertIsDisplayed().assertHasClickAction()
        val lastRow = compose.onNodeWithTag("agent:dense-5").fetchSemanticsNode().boundsInRoot
        val reviewButton = compose.onNodeWithTag("review-next").fetchSemanticsNode().boundsInRoot
        Assert.assertTrue("The last chat can scroll completely above the floating review action", lastRow.bottom <= reviewButton.top)
        assertCompleteTitle("mobile-companion")
        compose.onNodeWithContentDescription("Host: worker-6.production.uggs.io", useUnmergedTree = true).assertIsDisplayed()
        compose.onNode(hasContentDescription("Engine: Grok") and hasAnyAncestor(hasTestTag("agent:dense-5")), useUnmergedTree = true).assertIsDisplayed()
        Assert.assertFalse("Inspecting a long list does not load a transcript", transcriptRequested.get())
        Assert.assertEquals(setOf(session), unreadIds())
        screenshot("chat-home-dense-scrolled")
    }
    @Test fun unreachableAgentDisablesSendingAndKeepsDraft() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("project").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("project").performClick()
        waitForUnread(emptySet())
        compose.onNode(hasSetTextAction()).performTextInput("Keep this draft")
        reachable.set(false)
        changed("agents")
        compose.waitUntil(10000) { compose.onAllNodesWithText("Agent is no longer reachable").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        compose.onNode(hasSetTextAction()).assertTextContains("Keep this draft")
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("project").assertDoesNotExist()
        Assert.assertNull(sent.get())
    }
    @Test fun expiredApprovalCannotBeTapped() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("Review next · 1").fetchSemanticsNodes().isNotEmpty() }
        expiresAt = Instant.now().plusSeconds(8)
        changed("approvals")
        compose.waitUntil(10000) { compose.onAllNodesWithText("Review next · 1").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Review next · 1").performClick()
        compose.waitUntil(12000) { compose.onAllNodesWithText("Already handled or expired").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Allow 8h").assertIsNotEnabled()
        compose.onNodeWithText("Deny").assertIsNotEnabled()
        Assert.assertFalse(approved.get())
    }
    @Test fun staleNotificationCannotOpenRemovedConversation() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("project").fetchSemanticsNodes().isNotEmpty() }
        sessionListed.set(false)
        scenario.onActivity { activity ->
            activity.startActivity(android.content.Intent(activity, MainActivity::class.java)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("kind", "agent").putExtra("target_id", session))
        }
        compose.waitUntil(10000) { compose.onAllNodesWithText("Conversation is no longer available").fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty() }
        compose.onNodeWithText("Ready for your message.").assertDoesNotExist()
        compose.onNode(hasSetTextAction() and !hasTestTag("chat-search")).assertDoesNotExist()
        compose.onNodeWithText("project").assertDoesNotExist()
        waitForUnread(emptySet())
    }
    @Test fun unreadReplyCountDeduplicatesAndWaitsForTheRenderedReply() {
        compose.waitUntil(15000) { compose.onAllNodesWithTag("agent:$session").fetchSemanticsNodes().isNotEmpty() }
        waitForUnread(setOf(session))
        waitForUnreadBadge(1)
        compose.onNodeWithText("Orchestrator").assertIsDisplayed()
        compose.onNodeWithText("Unread chats").assertDoesNotExist()
        compose.onNodeWithText("1 unread chat", substring = true).assertDoesNotExist()
        summary.set("The build is still running.")
        changed("agents")
        compose.waitUntil(3000) { compose.onAllNodesWithText(summary.get()).fetchSemanticsNodes().isNotEmpty() }
        val beforeDuplicate = agentsRequested.get()
        changed("agents")
        compose.waitUntil(3000) { agentsRequested.get() > beforeDuplicate }
        waitForUnread(setOf(session))
        screenshot("unread-overview")

        holdTranscript.set(true)
        try {
            compose.onNodeWithTag("agent:$session").performClick()
            compose.waitUntil(5000) { transcriptRequested.get() }
            Assert.assertEquals("Opening a chat and fetching its snapshot must not mark an unseen reply read", setOf(session), unreadIds())
        } finally { holdTranscript.set(false) }
        compose.waitUntil(10000) { compose.onAllNodesWithText(reply.get()).fetchSemanticsNodes().isNotEmpty() }
        waitForUnread(emptySet())
        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithTag("agent:$session").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("agent:$session").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Read"))
        compose.onNodeWithText("1 unread chat", substring = true).assertDoesNotExist()

        history.add(JSONObject().put("cursor", 1).put("type", "assistant_message").put("payload", JSONObject().put("text", reply.get())))
        history.add(JSONObject().put("cursor", 2).put("type", "assistant_message").put("payload", JSONObject().put("text", "A fresh reply after your last read.")))
        history.add(JSONObject().put("cursor", 3).put("type", "progress").put("payload", JSONObject().put("text", "INTERNAL_LIFECYCLE")))
        reply.set("Another reply without reading the first.")
        history.add(JSONObject().put("cursor", 4).put("type", "assistant_message").put("payload", JSONObject().put("text", reply.get())))
        cursor.set(4)
        changed("agents")
        waitForUnread(setOf(session))
        waitForUnreadBadge(2)
        val beforeNewDuplicate = agentsRequested.get()
        changed("agents")
        compose.waitUntil(3000) { agentsRequested.get() > beforeNewDuplicate }
        Assert.assertEquals("Repeated delivery counts conversations once", setOf(session), unreadIds())
        waitForUnreadBadge(2)
        compose.onNodeWithTag("agent:$session").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText(reply.get()).fetchSemanticsNodes().isNotEmpty() }
        waitForUnread(emptySet())
    }
    @Test fun unreadDoesNotResurrectEndedOrOfflineSessions() {
        compose.waitUntil(15000) { compose.onAllNodesWithTag("agent:$session").fetchSemanticsNodes().isNotEmpty() }
        waitForUnread(setOf(session))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val preferences = context.getSharedPreferences(UnreadStore.PREFERENCES, android.content.Context.MODE_PRIVATE)
        val ledger = preferences.getString("state", null)
        for (state in listOf("offline", "ended")) {
            reachable.set(false); readOnly.set(true); presence.set(state)
            changed("agents")
            compose.waitUntil(5000) { compose.onAllNodesWithTag("agent:$session").fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithText("Conversation history · read only").assertDoesNotExist()
            Assert.assertEquals("Hidden history stays unread without adding a session row", setOf(session), unreadIds())
            Assert.assertEquals(ledger, preferences.getString("state", null))
            reachable.set(true); readOnly.set(false); presence.set("listening")
            changed("agents")
            waitForUnreadBadge(1)
        }
        screenshot("compact-unread-session")
    }
    @Test fun secondPushUpdatesTheNumberWithoutChangingTheUnreadSessionSet() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        compose.waitUntil(15000) { compose.onAllNodesWithTag("agent:$session").fetchSemanticsNodes().isNotEmpty() }
        waitForUnreadBadge(1)
        compose.waitUntil(5000) { manager.activeNotifications.any { it.notification.extras.getString(NOTIFICATION_KIND) == "unread" } }
        Assert.assertTrue("A snapshot must not create a synthetic reply alert", manager.activeNotifications.none { it.notification.extras.getString(NOTIFICATION_KIND) == "reply" })
        val requests = agentsRequested.get()
        history.add(JSONObject().put("cursor", 1).put("type", "assistant_message").put("payload", JSONObject().put("text", reply.get())))
        reply.set("A second real reply in the same session.")
        history.add(JSONObject().put("cursor", 2).put("type", "assistant_message").put("payload", JSONObject().put("text", reply.get())))
        cursor.set(2)
        val data = mapOf("device_id" to "test-device", "notification_id" to java.util.UUID.randomUUID().toString(), "kind" to "reply", "target_id" to session, "event_cursor" to "2", "summary" to reply.get())
        showCompanionNotification(context, data)
        waitForUnreadBadge(2)
        Assert.assertEquals("Only the shared-preference update changes the badge", requests, agentsRequested.get())
        Assert.assertEquals(setOf(session), unreadIds())
        showCompanionNotification(context, data)
        waitForUnreadBadge(2)
        Assert.assertEquals(setOf(session), unreadIds())
    }
    @Test fun unreadOverviewSurvivesNetworkLossAndReconnect() {
        compose.waitUntil(15000) { compose.onAllNodesWithTag("agent:$session").fetchSemanticsNodes().isNotEmpty() }
        waitForUnread(setOf(session))
        networkAvailable.set(false)
        live.getAndSet(null)?.close(1012, "Fixture network loss")
        try {
            compose.waitUntil(10000) { compose.onAllNodesWithText("Reconnecting…", substring = true).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("agent:$session").assertIsDisplayed()
            Assert.assertEquals(setOf(session), unreadIds())
            screenshot("unread-reconnecting")
        } finally { networkAvailable.set(true) }
        compose.waitUntil(15000) { compose.onAllNodesWithText("Reconnecting…", substring = true).fetchSemanticsNodes().isEmpty() }
        waitForUnreadBadge(1)
        compose.onNodeWithTag("agent:$session").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText(reply.get()).fetchSemanticsNodes().isNotEmpty() }
        waitForUnread(emptySet())
    }
    @Test fun latestReplyIsRecoveredWhenProgressFillsTheTranscriptTail() {
        compose.waitUntil(15000) { compose.onAllNodesWithTag("agent:$session").fetchSemanticsNodes().isNotEmpty() }
        val text = "The reply remains readable after a long build log."
        history.add(JSONObject().put("cursor", 10).put("type", "assistant_message").put("payload", JSONObject().put("text", text)))
        for (i in 11..270) history.add(JSONObject().put("cursor", i).put("type", "progress").put("payload", JSONObject().put("text", "INTERNAL_LIFECYCLE")))
        cursor.set(270); changed("agents")
        compose.waitUntil(5000) { UnreadStore(InstrumentationRegistry.getInstrumentation().targetContext).latestCursor(session) == 10L }
        waitForUnread(setOf(session))
        compose.onNodeWithTag("agent:$session").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
        Assert.assertTrue("The default tail really omitted the assistant reply", cursorsRequested.contains(-1))
        Assert.assertTrue("The exact reply is fetched after its preceding cursor", cursorsRequested.contains(9))
        compose.onNodeWithText(text).assertIsDisplayed()
        compose.onNodeWithText("INTERNAL_LIFECYCLE").assertDoesNotExist()
        waitForUnread(emptySet())
        screenshot("unread-recovered-reply")
    }
    @Test fun transcriptPermissionLossHidesUnreadWithoutAcknowledgingIt() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        val preferences = context.getSharedPreferences(UnreadStore.PREFERENCES, android.content.Context.MODE_PRIVATE)
        fun ownedNotifications() = manager.activeNotifications.filter { it.notification.extras.getString(NOTIFICATION_KIND) in setOf("reply", "unread") }
        compose.waitUntil(15000) { compose.onAllNodesWithTag("agent:$session").fetchSemanticsNodes().isNotEmpty() }
        for (i in 1..40) history.add(JSONObject().put("cursor", i).put("type", "assistant_message")
            .put("payload", JSONObject().put("text", "Earlier history reply $i.")))
        cursor.set(40); changed("agents")
        compose.waitUntil(5000) { UnreadStore(context).latestCursor(session) == 40L }
        compose.onNodeWithTag("agent:$session").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText("Earlier history reply 40.").fetchSemanticsNodes().isNotEmpty() }
        waitForUnread(emptySet())
        compose.onNodeWithTag("conversation").performScrollToIndex(0)
        compose.onNodeWithText("Earlier history reply 1.").assertIsDisplayed()
        history.add(JSONObject().put("cursor", 41).put("type", "assistant_message").put("payload", JSONObject().put("text", "An unseen reply still requires transcript permission.")))
        cursor.set(41); changed("agents")
        compose.waitUntil(5000) { compose.onAllNodesWithText("New messages").fetchSemanticsNodes().isNotEmpty() }
        waitForUnread(setOf(session))
        compose.waitUntil(5000) { ownedNotifications().any { it.notification.extras.getString(NOTIFICATION_KIND) == "unread" && it.notification.number == 1 } }
        val ledger = preferences.getString("state", null)
        Assert.assertEquals(40L, JSONObject(ledger!!).getJSONObject("sessions").getJSONObject(session).getLong("read"))

        transcriptAllowed.set(false); changed("me")
        compose.waitUntil(10000) { compose.onAllNodesWithTag("conversation").fetchSemanticsNodes().isEmpty() && ownedNotifications().isEmpty() }
        compose.onNodeWithTag("agent:$session").assertDoesNotExist()
        compose.onNodeWithText("1 unread chat", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Earlier history reply 1.").assertDoesNotExist()
        compose.onNode(hasSetTextAction() and !hasTestTag("chat-search")).assertDoesNotExist()
        Assert.assertEquals("Losing permission must preserve the last actual read marker and unseen reply", ledger, preferences.getString("state", null))
        Assert.assertEquals(setOf(session), unreadIds())
        screenshot("unread-permission-hidden")

        transcriptAllowed.set(true); changed("me")
        compose.waitUntil(10000) { compose.onAllNodesWithTag("agent:$session").fetchSemanticsNodes().isNotEmpty() }
        waitForUnreadBadge(1)
        compose.onNodeWithText("1 unread chat", substring = true).assertDoesNotExist()
        Assert.assertEquals("A restored snapshot still is not a read receipt", ledger, preferences.getString("state", null))
        compose.waitUntil(5000) { ownedNotifications().any { it.notification.extras.getString(NOTIFICATION_KIND) == "unread" && it.notification.number == 1 } }
        screenshot("unread-permission-restored")
    }
    @Test fun liveSummaryAndChatUpdateWithoutRefresh() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("project").fetchSemanticsNodes().isNotEmpty() }
        summary.set("Build passed; deployment awaits your decision.")
        changed("agents")
        compose.waitUntil(3000) { compose.onAllNodesWithText(summary.get()).fetchSemanticsNodes().isNotEmpty() }
        screenshot("live-summary")
        compose.onNodeWithText("project").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText(reply.get()).fetchSemanticsNodes().isNotEmpty() }
        reply.set("The new tests pass."); cursor.set(2)
        changed("agents")
        compose.waitUntil(3000) { compose.onAllNodesWithText(reply.get()).fetchSemanticsNodes().isNotEmpty() }
        changed("agents")
        compose.waitUntil(3000) { cursorsRequested.contains(2) }
        compose.onAllNodesWithText(reply.get()).assertCountEquals(1)
    }
    @Test fun reconnectAndResumeCatchUpWhilePreservingDraft() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("project").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("project").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText(reply.get()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasSetTextAction()).performTextInput("Keep this draft")
        reply.set("Reply during network loss."); cursor.set(2)
        live.getAndSet(null)?.close(1012, "restart")
        compose.waitUntil(10000) { compose.onAllNodesWithText(reply.get()).fetchSemanticsNodes().isNotEmpty() }
        Assert.assertTrue(cursorsRequested.contains(1))
        compose.onNode(hasSetTextAction()).assertTextContains("Keep this draft")
        scenario.moveToState(Lifecycle.State.CREATED)
        reply.set("Reply while backgrounded."); cursor.set(3)
        holdMe.set(true); meRequested.set(false)
        scenario.moveToState(Lifecycle.State.RESUMED)
        try {
            compose.waitUntil(10000) { meRequested.get() && compose.onAllNodesWithText("Connecting — draft kept").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Connecting…").assertIsDisplayed()
            compose.onNodeWithText("Connecting — draft kept").assertIsDisplayed()
            compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
            compose.onNode(hasSetTextAction()).assertTextContains("Keep this draft")
            compose.onNodeWithText(reply.get()).assertDoesNotExist()
        } finally { holdMe.set(false) }
        compose.waitUntil(10000) { compose.onAllNodesWithText(reply.get()).fetchSemanticsNodes().isNotEmpty() }
        Assert.assertTrue(cursorsRequested.contains(2))
        compose.onNode(hasSetTextAction()).assertTextContains("Keep this draft")
        compose.onNodeWithContentDescription("Send").assertIsEnabled()
        compose.onNodeWithText("Connecting — draft kept").assertDoesNotExist()
    }
    @Test fun summaryNotificationIsPrivateDeduplicatedAndOpensTheConversation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        compose.waitUntil(15000) { compose.onAllNodesWithText("project").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("project").performClick()
        compose.waitUntil(10000) { VisibleConversation.session == session && compose.onAllNodesWithText(reply.get()).fetchSemanticsNodes().isNotEmpty() }
        waitForUnread(emptySet())
        val id = java.util.UUID.randomUUID().toString()
        val data = mapOf("device_id" to "test-device", "notification_id" to id, "kind" to "reply", "target_id" to session, "event_cursor" to "2", "summary" to "DNS fixed; restart needs approval.")
        showCompanionNotification(context, data)
        fun replies() = manager.activeNotifications.filter { it.notification.extras.getString(NOTIFICATION_KIND) == "reply" && it.notification.extras.getString(NOTIFICATION_TARGET) == session }
        compose.waitUntil(5000) { replies().singleOrNull()?.notification?.extras?.getLong(NOTIFICATION_CURSOR) == 2L }
        val visible = replies().single()
        Assert.assertTrue("Visible replies are recorded without another alert", visible.notification.flags and android.app.Notification.FLAG_ONLY_ALERT_ONCE != 0)
        Assert.assertEquals(setOf(session), unreadIds())
        scenario.moveToState(Lifecycle.State.CREATED)
        val background = data + mapOf("notification_id" to java.util.UUID.randomUUID().toString(), "event_cursor" to "3")
        showCompanionNotification(context, background)
        compose.waitUntil(5000) { replies().singleOrNull()?.notification?.extras?.getLong(NOTIFICATION_CURSOR) == 3L }
        val receipt = replies().single()
        showCompanionNotification(context, background)
        Assert.assertEquals("Replies in one conversation share one notification", visible.key, replies().single().key)
        Assert.assertEquals("A duplicate push does not repost the alert", receipt.postTime, replies().single().postTime)
        val shown = receipt.notification
        Assert.assertEquals(background["summary"], shown.extras.getString("android.text"))
        Assert.assertEquals(background["summary"], shown.extras.getCharSequence("android.bigText").toString())
        Assert.assertEquals(android.app.Notification.VISIBILITY_PRIVATE, shown.visibility)
        reply.set(background.getValue("summary")); cursor.set(3)
        scenario.moveToState(Lifecycle.State.RESUMED)
        shown.contentIntent.send()
        compose.waitUntil(10000) { compose.onAllNodesWithText(reply.get()).fetchSemanticsNodes().isNotEmpty() }
        waitForUnread(emptySet())
        compose.waitUntil(5000) { replies().isEmpty() && manager.activeNotifications.none { it.notification.extras.getString(NOTIFICATION_KIND) == "unread" } }
    }
    @Test fun newMessagesRespectHistoryAndComposerRemainsVisibleWithKeyboard() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("project").fetchSemanticsNodes().isNotEmpty() }
        val start = Instant.now().minusSeconds(1800)
        for (i in 1..40) {
            val text = when (i) {
                1 -> "Earlier message to keep reading."
                40 -> "The checks passed. Ready when you are."
                else -> if (i % 3 == 0) "Please check the latest build and keep the current settings." else "Build step " + i + " is complete. Everything looks good so far."
            }
            history.add(JSONObject().put("cursor", i).put("type", if (i % 3 == 0) "user_message" else "assistant_message")
                .put("created_at", start.plusSeconds(i * 30L).toString()).put("payload", JSONObject().put("text", text)))
        }
        cursor.set(40)
        changed("agents")
        compose.waitUntil(5000) { UnreadStore(InstrumentationRegistry.getInstrumentation().targetContext).latestCursor(session) == 40L }
        compose.onNodeWithText("project").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText("The checks passed. Ready when you are.").fetchSemanticsNodes().isNotEmpty() }
        waitForUnread(emptySet())
        compose.onNodeWithTag("conversation").performScrollToIndex(0)
        compose.onNodeWithText("Earlier message to keep reading.").assertIsDisplayed()
        history.add(JSONObject().put("cursor", 41).put("type", "assistant_message").put("created_at", Instant.now().toString()).put("payload", JSONObject().put("text", "A new result arrived while you were reading.")))
        cursor.set(41); changed("agents")
        try { compose.waitUntil(5000) { compose.onAllNodesWithText("New messages").fetchSemanticsNodes().isNotEmpty() } } catch (failure: Throwable) { screenshot("history-failure"); throw failure }
        compose.onNodeWithText("Earlier message to keep reading.").assertIsDisplayed()
        waitForUnread(setOf(session))
        val beforeDuplicate = agentsRequested.get()
        changed("agents")
        compose.waitUntil(5000) { agentsRequested.get() > beforeDuplicate && cursorsRequested.contains(41) }
        Assert.assertEquals("Scrollback must retain an unseen later reply through duplicate snapshots", setOf(session), unreadIds())
        screenshot("history")
        compose.onNodeWithText("New messages").performClick()
        compose.onNodeWithText("A new result arrived while you were reading.").assertIsDisplayed()
        waitForUnread(emptySet())
        val draft = "Looks good. Please keep the current configuration."
        compose.onNode(hasSetTextAction()).performClick().performTextInput(draft)
        waitForKeyboard()
        screenshot("composer-keyboard")
        compose.onNodeWithText("A new result arrived while you were reading.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Send").assertIsDisplayed().performClick()
        try { compose.waitUntil(10000) { sent.get() == draft && compose.onAllNodesWithText(draft).fetchSemanticsNodes().isNotEmpty() } }
        catch (failure: Throwable) { screenshot("send-failure"); throw AssertionError("Sent content: ${sent.get()}; cursor: ${cursor.get()}; requested: $cursorsRequested", failure) }
        compose.onNodeWithText(draft).assertIsDisplayed()
        compose.onNodeWithContentDescription("Send").assertIsDisplayed()
        Assert.assertTrue("The outgoing user message does not create an unread reply", unreadIds().isEmpty())
        screenshot("modern-chat-keyboard")
    }

    private fun changed(scope: String) { Assert.assertTrue(live.get()?.send("""{"type":"changed","scopes":["$scope"]}""") == true) }
    private fun agentFixture(id: String, project: String, host: String, summary: String, engine: String, replyCursor: Long = 0, unreadCount: Int = 0) =
        JSONObject().put("id", id).put("session_name", project).put("host", host).put("engine", engine).put("cwd", "/work/$project")
            .put("presence", "listening").put("relay_ready", true).put("reply_cursor", replyCursor).put("unread_reply_count", unreadCount)
            .put("preview", JSONObject().put("summary", summary).put("created_at", "2026-10-07T19:00:00Z"))
    private fun waitForAgentRows(vararg ids: String) {
        compose.waitUntil(15000) { ids.all { compose.onAllNodesWithTag("agent:$it").fetchSemanticsNodes().isNotEmpty() } }
    }
    private fun assertCompleteTitle(title: String) {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(title, useUnmergedTree = true).assertIsDisplayed()
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        Assert.assertTrue("A complete project title has a rendered layout", layouts.isNotEmpty())
        Assert.assertTrue("Project title '$title' remains complete", layouts.all { layout -> (0 until layout.lineCount).none(layout::isLineEllipsized) })
    }
    private fun unreadLedger() = InstrumentationRegistry.getInstrumentation().targetContext
        .getSharedPreferences(UnreadStore.PREFERENCES, android.content.Context.MODE_PRIVATE).getString("state", null)
    private fun unreadIds() = UnreadStore(InstrumentationRegistry.getInstrumentation().targetContext).unreadIds()
    private fun waitForUnread(expected: Set<String>) { compose.waitUntil(10000) { unreadIds() == expected } }
    private fun waitForUnreadBadge(count: Int) {
        val description = if (count == 1) "1 unread reply" else "$count unread replies"
        compose.waitUntil(10000) { compose.onAllNodes(hasTestTag("agent:$session") and SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, description)).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("agent:$session").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, description))
    }
    private fun waitForKeyboard() {
        compose.waitUntil(5000) {
            var visible = false
            scenario.onActivity { activity ->
                visible = androidx.core.view.ViewCompat.getRootWindowInsets(activity.window.decorView)
                    ?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()) == true
            }
            visible
        }
    }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        android.os.SystemClock.sleep(350) // Let Android window transitions finish before capturing.
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.executeShellCommand("screencap -p /data/local/tmp/companion-$name${InstrumentationRegistry.getArguments().getString("screenshotSuffix", "")}.png").use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).readBytes()
        }
    }
}
