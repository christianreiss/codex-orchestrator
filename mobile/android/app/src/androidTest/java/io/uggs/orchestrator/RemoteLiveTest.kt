package io.uggs.orchestrator

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.*
import org.junit.runner.RunWith

/** Explicit opt-in acceptance test. Its pairing fixture must name the selected host. */
@RunWith(AndroidJUnit4::class)
class RemoteLiveTest {
    @get:Rule val compose = createEmptyComposeRule()

    /** A disposable local owner can verify pairing and revocation without any provider account. */
    @Test fun loopbackPairingShowsRegisteredHostAndRevokesDevice() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val name = InstrumentationRegistry.getArguments().getString("loopbackPairingFile")
        Assume.assumeTrue("Requires an isolated API and one-use loopback pairing", name != null)
        require(name!!.matches(Regex("[a-zA-Z0-9_-]+\\.json")))
        val context = instrumentation.targetContext
        val store = ConnectionStore(context)
        check(store.load() == null) { "Use an unpaired test device" }
        val fixture = try {
            context.openFileInput(name).bufferedReader().use { JSONObject(it.readText()) }
        } finally { context.deleteFile(name) }
        val code = fixture.getJSONObject("pairing").toString()
        val pairing = Pairing.parse(code)
        require(java.net.URI(pairing.server).host == "localhost")
        val cert = fixture.getString("certificate").byteInputStream().use {
            java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(it) as java.security.cert.X509Certificate
        }
        val trust = okhttp3.tls.HandshakeCertificates.Builder().addTrustedCertificate(cert).build()
        val client = Api.client
        Api.client = client.newBuilder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                compose.onNodeWithText(context.getString(R.string.pair_paste)).performClick()
                compose.onNode(hasSetTextAction()).performTextReplacement(code)
                compose.onNodeWithText(context.getString(R.string.action_continue)).performClick()
                compose.onNodeWithText(context.getString(R.string.action_connect)).performClick()
                compose.waitUntil(30_000) { compose.onAllNodesWithTag("tab-hosts").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("tab-hosts").performClick()
                compose.waitUntil(20_000) { compose.onAllNodesWithText(fixture.getString("host")).fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText(fixture.getString("host")).assertIsDisplayed()
                val connection = requireNotNull(store.load())
                val api = Api(connection.server, connection.token)
                runBlocking {
                    val replay = runCatching { Api(pairing.server).request("/pair", "POST", JSONObject().put("token", pairing.token).put("name", "Pairing replay")) }
                    Assert.assertEquals("pairing_invalid", (replay.exceptionOrNull() as? ApiException)?.code)
                    api.request("/device", "DELETE")
                    val rejected = runCatching { api.request("/me") }.exceptionOrNull() as? ApiException
                    Assert.assertEquals(401, rejected?.status)
                }
            }
        } finally {
            store.load()?.let { connection -> runBlocking { runCatching { Api(connection.server, connection.token).request("/device", "DELETE") } } }
            store.clear()
            Api.client = client
        }
    }

    @Test fun contactAndFollowupUseTheSameNativeTranscript() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val fixturePath = InstrumentationRegistry.getArguments().getString("livePairingPath")
        Assume.assumeTrue("Live acceptance requires an explicit pairing fixture", fixturePath != null)
        require(fixturePath!!.matches(Regex("/data/local/tmp/[a-zA-Z0-9._-]+")))
        val descriptor = instrumentation.uiAutomation.executeShellCommand("cat $fixturePath")
        val fixture = JSONObject(android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { String(it.readBytes()) })
        val pairing = Pairing.parse(fixture.getJSONObject("pairing").toString())
        val paired = runBlocking { Api(pairing.server).request("/pair", "POST", JSONObject().put("token", pairing.token).put("name", "Hosts live acceptance 0.4.10")) }
        val connection = Connection(pairing.server, paired.getString("token"), paired.getString("device_id"), paired.optJSONObject("firebase"))
        val context = instrumentation.targetContext
        val store = ConnectionStore(context)
        store.save(connection)
        val api = Api(connection.server, connection.token)
        val existingIds = runBlocking { api.request("/agents") }.getJSONArray("agents").objects().map { it.getString("id") }.toSet()
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        var conversation: JSONObject? = null
        try {
            compose.waitUntil(30_000) { compose.onAllNodesWithTag("tab-hosts").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("tab-hosts").performClick()
            compose.onNodeWithTag("host-search").performTextInput(fixture.getString("host"))
            val spawn = compose.onNodeWithTag("spawn:" + fixture.getLong("host_id"))
            compose.waitUntil(30_000) { runCatching { spawn.assertIsEnabled() }.isSuccess }
            spawn.performClick()
            compose.onNodeWithTag("confirm-spawn").performClick()
            compose.waitUntil(30_000) { compose.onAllNodesWithTag("conversation").fetchSemanticsNodes().isNotEmpty() }
            compose.waitUntil(240_000) {
                Thread.sleep(1_000)
                val agents = runBlocking { api.request("/agents") }.getJSONArray("agents").objects()
                conversation = agents.firstOrNull { it.getString("id") !in existingIds && it.optBoolean("daemon_session") && it.optString("host") == fixture.getString("host") && it.optString("remote_status") == "idle" && it.optLong("reply_cursor") > 0 }
                conversation != null
            }
            val first = conversation!!
            val sessionId = first.getString("id")
            val upstream = first.getString("upstream_session_id")
            val replyCursor = first.getLong("reply_cursor")
            compose.onNode(hasSetTextAction()).performTextInput("Antworte nur mit HOSTS-LIVE-OK. Veraendere keine Dateien und fuehre keine weiteren Aufgaben aus.")
            compose.waitUntil(30_000) { runCatching { compose.onNodeWithContentDescription("Send").assertIsEnabled() }.isSuccess }
            compose.onNodeWithContentDescription("Send").performClick()
            compose.waitUntil(30_000) {
                Thread.sleep(1_000)
                runBlocking { api.request("/agents/$sessionId/events?tail=1") }.getJSONArray("events").objects().any {
                    it.optString("type") == "user_message" && it.optJSONObject("payload")?.optString("text")?.contains("HOSTS-LIVE-OK") == true
                }
            }
            compose.waitUntil(240_000) {
                Thread.sleep(1_000)
                conversation = runBlocking { api.request("/agents") }.getJSONArray("agents").objects().firstOrNull { it.optString("id") == sessionId }
                conversation?.let { it.optString("remote_status") in setOf("failed", "unknown", "closed") || (it.optString("remote_status") == "idle" && it.optLong("reply_cursor") > replyCursor) } == true
            }
            Assert.assertEquals("Native continuation must succeed", "idle", conversation!!.getString("remote_status"))
            Assert.assertEquals(upstream, conversation!!.getString("upstream_session_id"))
            val events = runBlocking { api.request("/agents/$sessionId/events?tail=1") }.getJSONArray("events").objects()
            Assert.assertTrue(events.any { it.optString("type") == "assistant_message" && it.optJSONObject("payload")?.optString("text")?.contains("HOSTS-LIVE-OK") == true })
            Assert.assertTrue(events.count { it.optString("type") == "assistant_message" } >= 2)
            context.openFileOutput("live-remote-proof.json", 0).use { it.write(JSONObject().put("device_id", connection.deviceId).put("session_id", sessionId).put("upstream_session_id", upstream).put("assistant_messages", events.count { it.optString("type") == "assistant_message" }).toString().toByteArray()) }
        } finally {
            scenario.close()
            runBlocking { runCatching { api.request("/device", "DELETE") } }
            store.clear()
        }
    }
}
