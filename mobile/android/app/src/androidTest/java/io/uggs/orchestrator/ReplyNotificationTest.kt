package io.uggs.orchestrator

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.service.notification.StatusBarNotification
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Uses Android's real NotificationManager; no Firebase delivery or launcher-specific badge API. */
@RunWith(AndroidJUnit4::class)
class ReplyNotificationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val connection = Connection("https://notifications.example", "a".repeat(64), "notification-test-device", null)
    private val store = UnreadStore(context)
    private val runtimePermissionDenied = InstrumentationRegistry.getArguments().getString("runtimePermissionDenied") == "true"

    @Before fun setup() {
        instrumentation.waitForIdleSync()
        if (!runtimePermissionDenied && android.os.Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        shell("cmd appops set ${context.packageName} POST_NOTIFICATION default")
        await { NotificationManagerCompat.from(context).areNotificationsEnabled() != runtimePermissionDenied }
        manager.cancelAll()
        await { manager.activeNotifications.isEmpty() }
        ConnectionStore(context).save(connection)
        store.clear(); store.activate(connection)
        syncUnreadNotifications(context, connection, emptySet())
        context.getSharedPreferences("push-seen", Context.MODE_PRIVATE).edit().clear().commit()
        VisibleConversation.session = null
        // Android limits package notification updates to 5/s; keep independent test bursts separate.
        SystemClock.sleep(1_100)
    }

    @After fun cleanup() {
        shell("cmd appops set ${context.packageName} POST_NOTIFICATION default")
        VisibleConversation.session = null
        syncUnreadNotifications(context, null, emptySet())
        manager.cancelAll()
        store.clear()
        ConnectionStore(context).clear()
        context.getSharedPreferences("push-seen", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun stableConversationIdsAndOneBadgeCountWithoutRepeatedAlerts() {
        // These strings have the same Java hash: PendingIntent identity must still remain distinct.
        assertEquals("Aa".hashCode(), "BB".hashCode())
        push("Aa", 10, "first", "First reply.")
        push("Aa", 10, "first", "An immediate duplicate must not replace the reply.")
        push("Aa", 9, "immediate-late", "An immediate older reply must not replace the reply.")
        awaitBadge(1)
        await { replies().size == 1 }
        val original = reply("Aa")
        assertEquals("First reply.", original.notification.extras.getString(Notification.EXTRA_TEXT))
        assertEquals("first", original.notification.extras.getString(NOTIFICATION_PUSH_ID))
        SystemClock.sleep(1_100)
        push("Aa", 11, "second", "Second reply.")
        await { reply("Aa").notification.extras.getLong(NOTIFICATION_CURSOR) == 11L }
        assertEquals(original.key, reply("Aa").key)
        val updated = reply("Aa")
        push("Aa", 11, "second", "Duplicate must not replace the reply.")
        push("Aa", 10, "late", "Late reply must not replace the reply.")
        SystemClock.sleep(150)
        assertEquals(updated.postTime, reply("Aa").postTime)
        assertEquals("Second reply.", reply("Aa").notification.extras.getString(Notification.EXTRA_TEXT))
        assertEquals(1, badge().notification.number)

        SystemClock.sleep(1_100)
        push("BB", 30, "other", "Another conversation.")
        awaitBadge(2)
        await { replies().size == 2 }
        if (InstrumentationRegistry.getArguments().getString("captureLauncher") == "true") captureLauncher()
        assertEquals(2, replies().size)
        assertNotEquals(reply("Aa").notification.contentIntent, reply("BB").notification.contentIntent)
        assertFalse(manager.getNotificationChannel(REPLY_ALERT_CHANNEL).canShowBadge())
        assertTrue(manager.getNotificationChannel(UNREAD_BADGE_CHANNEL).canShowBadge())
        assertEquals(NotificationManager.IMPORTANCE_LOW, manager.getNotificationChannel(UNREAD_BADGE_CHANNEL).importance)
        assertNull(manager.getNotificationChannel(UNREAD_BADGE_CHANNEL).sound)
        for (entry in replies()) {
            assertEquals(REPLY_ALERT_CHANNEL, entry.notification.channelId)
            assertEquals(0, entry.notification.number)
            assertEquals(Notification.VISIBILITY_PRIVATE, entry.notification.visibility)
            assertEquals(0, entry.notification.flags and Notification.FLAG_AUTO_CANCEL)
        }
        assertEquals(UNREAD_BADGE_CHANNEL, badge().notification.channelId)
        assertEquals(0, badge().notification.flags and Notification.FLAG_GROUP_SUMMARY)
        assertNull(badge().notification.extras.getString(NOTIFICATION_TARGET))
    }

    @Test fun foregroundCursorFencesLatePushAndOnlyActualReadClearsNotifications() {
        snapshot("chat" to 20L)
        sync()
        awaitBadge(1)
        assertTrue("Snapshots create only the silent badge, never a synthetic reply", replies().isEmpty())
        val counter = badge()
        push("chat", 10, "older", "Old reply.")
        SystemClock.sleep(150)
        assertTrue("A late push must not create an alert for an older reply", replies().isEmpty())
        assertEquals(counter.postTime, badge().postTime)
        SystemClock.sleep(1_100)
        push("chat", 20, "first-fcm-for-snapshot", "The source summary for the known unread reply.")
        await { reply("chat").notification.extras.getString(NOTIFICATION_PUSH_ID) == "first-fcm-for-snapshot" }
        val firstPush = reply("chat")
        assertEquals("The source summary for the known unread reply.", firstPush.notification.extras.getString(Notification.EXTRA_TEXT))
        snapshot("chat" to 20L)
        sync()
        assertEquals("A snapshot retains the genuine source alert", firstPush.postTime, reply("chat").postTime)
        push("chat", 20, "different-uuid-same-cursor", "The same event must not alert twice.")
        SystemClock.sleep(150)
        assertEquals(firstPush.postTime, reply("chat").postTime)
        SystemClock.sleep(1_100)
        push("chat", 21, "newer", "Reply while the transcript was loading.")
        await { reply("chat").notification.extras.getLong(NOTIFICATION_CURSOR) == 21L }
        store.markRead("chat", 20)
        sync()
        awaitBadge(1)
        assertEquals(21L, reply("chat").notification.extras.getLong(NOTIFICATION_CURSOR))
        store.markRead("chat", 21)
        sync()
        await { owned().isEmpty() }
        push("chat", 21, "already-read", "Must not resurrect a read reply.")
        SystemClock.sleep(150)
        assertTrue(owned().isEmpty())
        assertTrue(store.unreadIds().isEmpty())
    }

    @Test fun immediateReadCancelsEvenAnEnqueuedPush() {
        push("fast-read", 9, "in-flight", "Read immediately.")
        store.markRead("fast-read", 9)
        sync()
        SystemClock.sleep(250)
        assertTrue(owned().isEmpty())
    }

    @Test fun foregroundRepliesIncludeReadOnlyChatsAndDoNotPersistBodies() {
        val agents = listOf(
            JSONObject().put("id", "closed").put("reply_cursor", "7").put("presence", "closed").put("relay_ready", false),
            JSONObject().put("id", "offline").put("reply_cursor", "12").put("presence", "offline").put("relay_ready", false)
        )
        store.observeReplies(agents)
        sync()
        awaitBadge(2)
        assertEquals("Retained history produces one quiet counter", 1, owned().size)
        assertTrue(replies().isEmpty())
        assertNotNull(badge().notification.contentIntent)
        assertTrue(badge().notification.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
        val synthetic = NotificationCompat.Builder(context, REPLY_ALERT_CHANNEL).setSmallIcon(R.drawable.ic_companion)
            .setContentTitle("Agent reply").setContentText("Open this conversation to read the reply.")
            .addExtras(Bundle().apply {
                putString(NOTIFICATION_KIND, "reply")
                putString(NOTIFICATION_SCOPE, unreadScope(connection.server, connection.deviceId))
                putString(NOTIFICATION_TARGET, "offline")
            }).build()
        manager.notify("previous-synthetic", 711, synthetic)
        await { manager.activeNotifications.any { it.id == 711 } }
        sync()
        await { manager.activeNotifications.none { it.id == 711 } }
        assertTrue("An upgrade removes old synthetic alerts while preserving the unread counter", replies().isEmpty())
        SystemClock.sleep(1_100)
        push("closed", 8, "private", "A body must remain outside persistent unread state.")
        await { reply("closed").notification.extras.getLong(NOTIFICATION_CURSOR) == 8L }
        val preferences = context.getSharedPreferences(UnreadStore.PREFERENCES, Context.MODE_PRIVATE).all.toString()
        assertFalse(preferences.contains("A body must remain outside"))
        assertFalse(preferences.contains(connection.token))
        assertFalse(preferences.contains(connection.server))
        store.markRead("closed", 8)
        sync()
        await { replies().isEmpty() && badge().notification.number == 1 }
    }

    @Test fun readAndOptOutPreserveApprovalAttentionAndAmbiguousLegacyNotifications() {
        val preservedIds = setOf("approval-id".hashCode(), "attention-id".hashCode(), 709)
        showCompanionNotification(context, data("approval", "42", "approval-id"))
        showCompanionNotification(context, data("attention", "chat", "attention-id"))
        manager.notify(709, NotificationCompat.Builder(context, "agents").setSmallIcon(R.drawable.ic_companion)
            .setContentTitle("Legacy agent update").build())
        push("chat", 50, "reply-id", "Actual reply.")
        awaitBadge(1)
        await { manager.activeNotifications.map { it.id }.containsAll(preservedIds) }
        val legacyReply = NotificationCompat.Builder(context, "agents").setSmallIcon(R.drawable.ic_companion)
            .addExtras(Bundle().apply {
                putString(NOTIFICATION_KIND, "reply")
                putString(NOTIFICATION_SCOPE, unreadScope(connection.server, connection.deviceId))
                putString(NOTIFICATION_TARGET, "chat")
            }).build()
        manager.notify(710, legacyReply)
        await { manager.activeNotifications.any { it.id == 710 } }
        store.markRead("chat", 50)
        sync()
        await { owned().isEmpty() && ordinaryNotificationIds() == preservedIds }
        assertFalse(manager.activeNotifications.any { it.id == 710 })
        SystemClock.sleep(1_100)
        push("chat", 51, "another", "One more reply.")
        awaitBadge(1)
        syncUnreadNotifications(context, null, emptySet())
        await { owned().isEmpty() }
        assertEquals(preservedIds, ordinaryNotificationIds())
        assertEquals(setOf("chat"), store.unreadIds())
        push("chat", 52, "late-after-opt-out", "A queued push after opting out.")
        SystemClock.sleep(100)
        assertTrue(owned().isEmpty())
        assertEquals(preservedIds, ordinaryNotificationIds())
        assertEquals(52L, store.latestCursor("chat"))
        SystemClock.sleep(1_100)
        sync()
        awaitBadge(1)
        assertTrue("Re-enabling notifications restores the badge without reconstructing old alerts", replies().isEmpty())
        assertTrue(badge().notification.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
    }

    @Test fun notificationOptOutStillRecordsUnreadAndForegroundRestoresSilentBadge() {
        // For actual Android permission denial, the host revokes POST_NOTIFICATIONS before
        // launching only this case with runtimePermissionDenied=true (revoking in-process kills it).
        if (!runtimePermissionDenied) syncUnreadNotifications(context, null, emptySet())
        push("no-permission", 81, "blocked", "Notification delivery is disabled.")
        assertEquals(setOf("no-permission"), store.unreadIds())
        SystemClock.sleep(100)
        assertTrue(manager.activeNotifications.isEmpty())
        if (runtimePermissionDenied) {
            assertFalse(NotificationManagerCompat.from(context).areNotificationsEnabled())
            return
        }
        sync()
        awaitBadge(1)
        assertTrue(replies().isEmpty())
        assertTrue(badge().notification.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
        assertFalse(badge().notification.extras.getString(Notification.EXTRA_TEXT)!!.contains("delivery is disabled"))
    }

    @Test fun serverDeviceScopeAndStaleForegroundSnapshotCannotCancelNewReplies() {
        push("old-scope", 1, "old", "Previous server.")
        awaitBadge(1)
        await { replies().size == 1 }
        val oldKey = reply("old-scope").key
        val changed = connection.copy(server = "https://other.example", deviceId = "other-device")
        SystemClock.sleep(1_100)
        ConnectionStore(context).save(changed)
        store.activate(changed)
        snapshot("new-scope" to 22L)
        syncUnreadNotifications(context, changed, store.unreadIds())
        await { owned().size == 1 && replies().isEmpty() && badge().notification.number == 1 }
        assertFalse(manager.activeNotifications.any { it.key == oldKey })
        val oldSnapshot = store.unreadIds()
        SystemClock.sleep(1_100)
        showCompanionNotification(context, data("reply", "second", "second-id", 23).plus("device_id" to changed.deviceId))
        awaitBadge(2)
        await { replies().size == 1 }
        syncUnreadNotifications(context, changed, oldSnapshot)
        SystemClock.sleep(100)
        assertEquals(setOf("second"), replies().map { it.notification.extras.getString(NOTIFICATION_TARGET) }.toSet())
        assertEquals(setOf("new-scope", "second"), store.unreadIds())
        assertEquals(2, badge().notification.number)
    }

    @Test fun visibleConversationStaysUnreadUntilReadAndLegacyPushIsDeduplicated() {
        VisibleConversation.session = "visible"
        showCompanionNotification(context, data("reply", "visible", "legacy"))
        awaitBadge(1)
        await { replies().size == 1 }
        val original = reply("visible")
        assertTrue(original.notification.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
        VisibleConversation.session = null
        showCompanionNotification(context, data("reply", "visible", "legacy"))
        SystemClock.sleep(100)
        assertEquals(original.postTime, reply("visible").postTime)
        snapshot("visible" to 5L)
        store.markRead("visible", 5)
        sync()
        await { owned().isEmpty() }
        showCompanionNotification(context, data("reply", "visible", "legacy"))
        SystemClock.sleep(100)
        assertTrue(owned().isEmpty())
        assertTrue(store.unreadIds().isEmpty())
    }

    private fun snapshot(vararg cursors: Pair<String, Long>) {
        store.observeReplies(cursors.map { (id, cursor) -> JSONObject().put("id", id).put("reply_cursor", cursor.toString()) })
    }
    private fun sync() = syncUnreadNotifications(context, connection, store.unreadIds())
    private fun push(target: String, cursor: Long, id: String, summary: String) = showCompanionNotification(context, data("reply", target, id, cursor).plus("summary" to summary))
    private fun data(kind: String, target: String, id: String, cursor: Long? = null): Map<String, String> = mapOf(
        "device_id" to connection.deviceId, "notification_id" to id, "kind" to kind, "target_id" to target
    ).let { if (cursor == null) it else it.plus("event_cursor" to cursor.toString()) }
    private fun owned(): List<StatusBarNotification> = manager.activeNotifications.filter { it.notification.extras.getString(NOTIFICATION_KIND) in setOf("reply", "unread") }
    // Android may retain its own auto-group summary after the fourth ungrouped item is removed.
    // Explicit reply summaries are checked separately by owned(), so none can escape this assertion.
    private fun ordinaryNotificationIds(): Set<Int> = manager.activeNotifications.filter {
        it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0
    }.map { it.id }.toSet()
    private fun replies(): List<StatusBarNotification> = owned().filter { it.notification.extras.getString(NOTIFICATION_KIND) == "reply" }
    private fun reply(target: String): StatusBarNotification = replies().single { it.notification.extras.getString(NOTIFICATION_TARGET) == target }
    private fun badge(): StatusBarNotification = owned().single { it.notification.extras.getString(NOTIFICATION_KIND) == "unread" }
    private fun awaitBadge(count: Int) = await { owned().count { it.notification.extras.getString(NOTIFICATION_KIND) == "unread" && it.notification.number == count } == 1 }
    private fun await(condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 5_000
        while (!runCatching(condition).getOrDefault(false) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(25)
        assertTrue("Notification state did not converge", condition())
    }
    private fun shell(command: String) {
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).use { it.readBytes() }
    }
    private fun captureLauncher() {
        // Opt-in visual proof on the dedicated 1080x2400 Pixel emulator, after the suite.
        shell("input keyevent KEYCODE_HOME")
        // Let reply heads-up alerts expire, then give the listener and launcher time to render.
        SystemClock.sleep(5_500)
        shell("input swipe 540 1900 540 600 400")
        SystemClock.sleep(3_000)
        if (launcherIcon(instrumentation.uiAutomation.rootInActiveWindow) == null) {
            shell("input tap 540 140")
            shell("input text Orchestrator")
            SystemClock.sleep(3_000)
        }
        val icon = launcherIcon(instrumentation.uiAutomation.rootInActiveWindow)
        assertNotNull("The launcher must show the Orchestrator icon", icon)
        val description = icon?.contentDescription?.toString()
        if (!description.isNullOrBlank()) assertTrue("The launcher icon must expose unread notifications: $description", description.contains("notification", ignoreCase = true))
        shell("screencap -p /data/local/tmp/companion-unread-launcher.png")
    }
    private fun launcherIcon(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isVisibleToUser && node.isClickable && (node.text?.toString()?.equals("Orchestrator", ignoreCase = true) == true ||
                node.contentDescription?.toString()?.startsWith("Orchestrator", ignoreCase = true) == true)) return node
        for (index in 0 until node.childCount) launcherIcon(node.getChild(index))?.let { return it }
        return null
    }
}
