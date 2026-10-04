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
    private val session = "68e117f3-e14b-4b86-a4c0-79808bf142c4"
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
                val body = when {
                    path == "/me" -> """{"device_id":"test-device","name":"Operator","capabilities":["agent_portal.read","agent_portal.reveal_transcript","agent_portal.manage","hosts.activate_insecure"],"notifications":true,"follows":[],"firebase":${firebase ?: "null"}}"""
                    path == "/device" && request.method == "PATCH" -> {
                        val body = JSONObject(request.body.readUtf8())
                        if (body.has("fcm_token")) registeredToken.set(body.getString("fcm_token"))
                        "{}"
                    }
                    path == "/agents" -> """{"agents":[{"id":"$session","host":"lab.uggs.io","engine":"codex","cwd":"/work/project","presence":"listening","relay_ready":${reachable.get()},"pending_prompt":${if (questionPending.get()) """{"id":"question-1","version":1,"question":"Which target?","options":["Staging","Production"]}""" else "null"}},{"id":"offline","host":"offline.uggs.io","cwd":"/old/offline-project","presence":"offline","relay_ready":false},{"id":"idle","host":"idle.uggs.io","cwd":"/old/idle-project","presence":"idle","relay_ready":false}]}"""
                    path == "/agents/$session/events" -> """{"events":[{"cursor":0,"type":"session_started","payload":{"text":"INTERNAL_LIFECYCLE"}},{"cursor":1,"type":"assistant_message","payload":{"text":"Ready for your message."}}],"next_cursor":1}"""
                    path == "/events" -> return MockResponse().setHeader("Content-Type", "text/event-stream").setBody(": heartbeat\n\n")
                    path == "/approvals" -> if (approved.get()) """{"requests":[],"default_duration_minutes":480}""" else """{"requests":[{"id":42,"fqdn":"waiting.uggs.io","request_ip":"192.0.2.42","live":true,"expires_at":"${expiresAt}"}],"default_duration_minutes":480}"""
                    path == "/approvals/42/approve" -> { approved.set(true); "{}" }
                    path == "/agents/$session/prompts/question-1/answer" -> { answered.set(JSONObject(request.body.readUtf8()).getString("answer")); questionPending.set(false); "{}" }
                    path == "/agents/$session/messages" -> { sent.set(JSONObject(request.body.readUtf8()).getString("content")); "{}" }
                    else -> "{}"
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody("{\"status\":\"ok\",\"data\":$body}")
            }
        }
        server.start()
        ConnectionStore(context).save(Connection(server.url("/").toString().trimEnd('/'), "a".repeat(64), "test-device", firebase))
        if (firebase != null) configurePush(context, ConnectionStore(context).load()!!)
        if (android.os.Build.VERSION.SDK_INT >= 33) InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }
    @After fun cleanup() {
        scenario.close()
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
        compose.waitUntil(15000) { compose.onAllNodesWithText("project").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("project").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText("Ready for your message.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("INTERNAL_LIFECYCLE").assertDoesNotExist()
        compose.onNode(hasSetTextAction()).performTextInput("Please check the build")
        compose.onNodeWithText("Send", useUnmergedTree = true).performClick()
        compose.waitUntil(10000) { sent.get() != null }
        Assert.assertEquals("Please check the build", sent.get())
        screenshot("chat")
        compose.onNodeWithText("Back").performClick()
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
        compose.onNodeWithText("More").performClick()
        compose.onNodeWithText("Refresh").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText("Which target?").fetchSemanticsNodes().isNotEmpty() }
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
        compose.onNodeWithText("More").performClick()
        compose.onNodeWithText("Refresh").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText("Agent is no longer reachable").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Send").assertIsNotEnabled()
        compose.onNode(hasSetTextAction()).assertTextContains("Keep this draft")
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithText("project").assertDoesNotExist()
        Assert.assertNull(sent.get())
    }
    @Test fun expiredApprovalCannotBeTapped() {
        compose.waitUntil(15000) { compose.onAllNodesWithText("Review next · 1").fetchSemanticsNodes().isNotEmpty() }
        expiresAt = Instant.now().plusSeconds(8)
        compose.onNodeWithText("More").performClick()
        compose.onNodeWithText("Refresh").performClick()
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
        compose.waitUntil(10000) { compose.onAllNodesWithText("Agent is no longer reachable").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Ready for your message.").assertDoesNotExist()
        compose.onNode(hasSetTextAction()).assertDoesNotExist()
        compose.onNodeWithText("project").assertDoesNotExist()
    }
    private fun screenshot(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.executeShellCommand("screencap -p /data/local/tmp/companion-$name.png").use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).readBytes()
        }
    }
}
