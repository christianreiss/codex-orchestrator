package io.uggs.orchestrator

import android.Manifest
import android.app.NotificationManager
import androidx.lifecycle.Lifecycle
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
    @get:Rule val compose = createEmptyComposeRule()
    private val server = MockWebServer()
    private lateinit var scenario: ActivityScenario<MainActivity>
    private lateinit var originalClient: OkHttpClient
    private var firebase: JSONObject? = null
    private val registeredToken = AtomicReference<String?>(null)
    private val approved = AtomicBoolean(false)
    private val questionPending = AtomicBoolean(false)
    private val reachable = AtomicBoolean(true)
    private val answered = AtomicReference<String?>(null)
    private var expiresAt = Instant.now().plusSeconds(120)
    private val sent = AtomicReference<String?>(null)
    private val live = AtomicReference<WebSocket?>(null)
    private val summary = AtomicReference("Ready for your message.")
    private val reply = AtomicReference("Ready for your message.")
    private val cursor = AtomicLong(1)
    private val history = CopyOnWriteArrayList<JSONObject>()
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
                val path = request.path!!.substringBefore('?').removePrefix("/companion/v1")
                if (path == "/ws") return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) { live.set(webSocket); webSocket.send("""{"type":"hello"}""") }
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { live.compareAndSet(webSocket, null) }
                })
                val body = when {
                    path == "/me" -> """{"device_id":"test-device","name":"Operator","capabilities":["agent_portal.read","agent_portal.reveal_transcript","agent_portal.manage","hosts.activate_insecure"],"notifications":true,"follows":[],"firebase":${firebase ?: "null"}}"""
                    path == "/device" && request.method == "PATCH" -> {
                        val body = JSONObject(request.body.readUtf8())
                        if (body.has("fcm_token")) registeredToken.set(body.getString("fcm_token"))
                        "{}"
                    }
                    path == "/agents" -> """{"agents":[{"id":"$session","host":${JSONObject.quote(fixtureHost)},"engine":${JSONObject.quote(fixtureEngine)},"cwd":${JSONObject.quote("/work/$fixtureProject")},"presence":"listening","relay_ready":${reachable.get()},"preview":{"summary":${JSONObject.quote(if (questionPending.get()) "Choose a target." else summary.get())}},"pending_prompt":${if (questionPending.get()) """{"id":"question-1","version":1,"question":"Which target?","options":["Staging","Production"]}""" else "null"}},{"id":"offline","host":"offline.uggs.io","cwd":"/old/offline-project","presence":"offline","relay_ready":false},{"id":"idle","host":"idle.uggs.io","cwd":"/old/idle-project","presence":"idle","relay_ready":false}]}"""
                    path == "/agents/$session/events" -> {
                        val after = request.requestUrl?.queryParameter("after")?.toLongOrNull() ?: -1
                        cursorsRequested.add(after)
                        val rows = if (history.isNotEmpty()) history.filter { it.getLong("cursor") > after }.joinToString(",") { it.toString() } else if (after >= cursor.get()) "" else """{"cursor":${cursor.get()},"type":"assistant_message","payload":{"text":${JSONObject.quote(reply.get())}}}"""
                        """{"events":[$rows],"next_cursor":${cursor.get()}}"""
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
        ConnectionStore(context).save(Connection(server.url("/").toString().trimEnd('/'), "a".repeat(64), "test-device", firebase))
        if (firebase != null) configurePush(context, ConnectionStore(context).load()!!)
        if (android.os.Build.VERSION.SDK_INT >= 33) InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }
    @After fun cleanup() {
        scenario.close()
        heartbeat.shutdownNow()
        live.getAndSet(null)?.close(1001, "Test finished")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        context.deleteFile("fcm-delivery-test.json")
        context.getSystemService(NotificationManager::class.java).cancelAll()
        ConnectionStore(context).clear()
        Api.client = originalClient
        server.shutdown()
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
    @Test fun unreachableAgentDisablesSendingAndKeepsDraft() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("project").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("project").performClick()
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
    @Test fun staleNotificationCannotOpenUnreachableAgent() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("project").fetchSemanticsNodes().isNotEmpty() }
        reachable.set(false)
        scenario.onActivity { activity ->
            activity.startActivity(android.content.Intent(activity, MainActivity::class.java)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("kind", "agent").putExtra("target_id", session))
        }
        compose.waitUntil(10000) { compose.onAllNodesWithText("Agent is no longer reachable").fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty() }
        compose.onNodeWithText("Ready for your message.").assertDoesNotExist()
        compose.onNode(hasSetTextAction()).assertDoesNotExist()
        compose.onNodeWithText("project").assertDoesNotExist()
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
        scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitUntil(10000) { compose.onAllNodesWithText(reply.get()).fetchSemanticsNodes().isNotEmpty() }
        Assert.assertTrue(cursorsRequested.contains(2))
        compose.onNode(hasSetTextAction()).assertTextContains("Keep this draft")
    }
    @Test fun summaryNotificationIsPrivateDeduplicatedAndOpensTheConversation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        compose.waitUntil(15000) { compose.onAllNodesWithText("project").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("project").performClick()
        compose.waitUntil(10000) { VisibleConversation.session == session }
        val id = java.util.UUID.randomUUID().toString()
        val data = mapOf("device_id" to "test-device", "notification_id" to id, "kind" to "reply", "target_id" to session, "summary" to "DNS fixed; restart needs approval.")
        showCompanionNotification(context, data)
        Assert.assertTrue(manager.activeNotifications.isEmpty())
        scenario.moveToState(Lifecycle.State.CREATED)
        showCompanionNotification(context, data); showCompanionNotification(context, data)
        compose.waitUntil(5000) { manager.activeNotifications.isNotEmpty() }
        val shown = manager.activeNotifications.single().notification
        Assert.assertEquals(data["summary"], shown.extras.getString("android.text"))
        Assert.assertEquals(data["summary"], shown.extras.getCharSequence("android.bigText").toString())
        Assert.assertEquals(android.app.Notification.VISIBILITY_PRIVATE, shown.visibility)
        scenario.moveToState(Lifecycle.State.RESUMED)
        shown.contentIntent.send()
        compose.waitUntil(10000) { compose.onAllNodesWithText("Ready for your message.").fetchSemanticsNodes().isNotEmpty() }
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
        compose.onNodeWithText("project").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText("The checks passed. Ready when you are.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("conversation").performScrollToIndex(0)
        compose.onNodeWithText("Earlier message to keep reading.").assertIsDisplayed()
        history.add(JSONObject().put("cursor", 41).put("type", "assistant_message").put("created_at", Instant.now().toString()).put("payload", JSONObject().put("text", "A new result arrived while you were reading.")))
        cursor.set(41); changed("agents")
        try { compose.waitUntil(5000) { compose.onAllNodesWithText("New messages").fetchSemanticsNodes().isNotEmpty() } } catch (failure: Throwable) { screenshot("history-failure"); throw failure }
        compose.onNodeWithText("Earlier message to keep reading.").assertIsDisplayed()
        screenshot("history")
        compose.onNodeWithText("New messages").performClick()
        compose.onNodeWithText("A new result arrived while you were reading.").assertIsDisplayed()
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
        screenshot("modern-chat-keyboard")
    }

    private fun changed(scope: String) { Assert.assertTrue(live.get()?.send("""{"type":"changed","scopes":["$scope"]}""") == true) }
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
