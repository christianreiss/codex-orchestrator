package io.uggs.orchestrator

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.SharedPreferences
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject

class CompanionApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannels(this)
        ConnectionStore(this).load()?.let { configurePush(this, it) }
    }
}

object PushStatus { val state = MutableStateFlow("Push is not configured") }

fun configurePush(context: Context, connection: Connection) {
    val config = connection.firebase ?: return
    PushStatus.state.value = "Registering notifications…"
    try {
        val existing = FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
        if (existing != null && existing.options.applicationId != config.getString("app_id")) existing.delete()
        if (FirebaseApp.getApps(context).none { it.name == FirebaseApp.DEFAULT_APP_NAME }) {
            FirebaseApp.initializeApp(context, FirebaseOptions.Builder().setApplicationId(config.getString("app_id"))
                .setApiKey(config.getString("api_key")).setGcmSenderId(config.getString("sender_id")).setProjectId(config.getString("project_id")).build())
        }
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> registerPushToken(context, token) }
            .addOnFailureListener { PushStatus.state.value = "Firebase registration failed. Reopen the app to retry." }
    } catch (_: Exception) { PushStatus.state.value = "Push configuration failed. Check the server settings." }
}

private fun registerPushToken(context: Context, token: String) {
    val connection = ConnectionStore(context).load() ?: return
    CoroutineScope(Dispatchers.IO).launch {
        runCatching { Api(connection.server, connection.token).request("/device", "PATCH", JSONObject().put("fcm_token", token)) }
            .onSuccess { PushStatus.state.value = "Notifications registered" }
            .onFailure { PushStatus.state.value = "Could not register this device with the server. Reopen to retry." }
    }
}

object VisibleConversation { @Volatile var session: String? = null }

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { registerPushToken(this, token) }
    override fun onMessageReceived(message: RemoteMessage) { showCompanionNotification(this, message.data) }
}

internal const val REPLY_ALERT_CHANNEL = "agent-replies"
internal const val UNREAD_BADGE_CHANNEL = "unread-replies"
internal const val NOTIFICATION_KIND = "io.uggs.orchestrator.kind"
internal const val NOTIFICATION_SCOPE = "io.uggs.orchestrator.scope"
internal const val NOTIFICATION_TARGET = "io.uggs.orchestrator.target"
internal const val NOTIFICATION_CURSOR = "io.uggs.orchestrator.cursor"
internal const val NOTIFICATION_PUSH_ID = "io.uggs.orchestrator.push_id"
private const val REPLY_NOTIFICATION_ID = 1
private const val UNREAD_NOTIFICATION_ID = 2
private const val REPLY_POLICY_PREFERENCES = "reply-notification-policy"
private const val REPLY_CURSOR_PREFIX = "reply-cursor:"
// Android enqueues notify() asynchronously. Track IDs until activeNotifications catches up,
// so a read immediately following a push can also cancel an in-flight notification.
private val knownReplyTargets = mutableMapOf<String, MutableSet<String>>()
private val pendingReplyPosts = mutableMapOf<Pair<String, String>, Long>()

private fun ensureNotificationChannels(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    // Existing channels retain the operator's notification preferences.
    manager.createNotificationChannel(NotificationChannel("approvals", "Host access", NotificationManager.IMPORTANCE_HIGH))
    manager.createNotificationChannel(NotificationChannel("agents", "Agent conversations", NotificationManager.IMPORTANCE_HIGH))
    manager.createNotificationChannel(NotificationChannel(REPLY_ALERT_CHANNEL, "Agent replies", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "New replies in agent conversations"
        setShowBadge(false)
    })
    manager.createNotificationChannel(NotificationChannel(UNREAD_BADGE_CHANNEL, "Unread conversations", NotificationManager.IMPORTANCE_LOW).apply {
        description = "A silent count of conversations with unread replies"
        setShowBadge(true)
        setSound(null, null)
        enableVibration(false)
    })
}

private fun notificationsAllowed(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled() &&
    (android.os.Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

private fun channelAllowed(manager: NotificationManager, channel: String): Boolean =
    manager.getNotificationChannel(channel)?.importance != NotificationManager.IMPORTANCE_NONE

private fun postNotification(context: Context, tag: String?, id: Int, notification: Notification): Boolean {
    if (android.os.Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
    return try {
        NotificationManagerCompat.from(context).notify(tag, id, notification)
        true
    } catch (_: SecurityException) {
        // Permission may be revoked between the check and the Binder call.
        false
    }
}

private fun saveReplyNotificationPolicy(context: Context, connection: Connection?) {
    val prefs = context.getSharedPreferences(REPLY_POLICY_PREFERENCES, Context.MODE_PRIVATE)
    val current = connection ?: ConnectionStore(context).load()
    if (current == null) {
        if (prefs.all.isNotEmpty()) prefs.edit().clear().apply()
        return
    }
    val scope = unreadScope(current.server, current.deviceId)
    val enabled = connection != null
    if (prefs.getString("scope", null) != scope || prefs.getBoolean("enabled", true) != enabled) {
        prefs.edit().clear().putString("scope", scope).putBoolean("enabled", enabled).apply()
    }
}

private fun replyNotificationsEnabled(context: Context, scope: String): Boolean {
    val prefs = context.getSharedPreferences(REPLY_POLICY_PREFERENCES, Context.MODE_PRIVATE)
    return prefs.getString("scope", null) != scope || prefs.getBoolean("enabled", true)
}

private fun rememberPush(seen: SharedPreferences, scope: String, id: String, target: String? = null, cursor: Long? = null) {
    val all = seen.all
    val editor = seen.edit()
    val ids = all.filterValues { it is Boolean }.keys.filter { it != id }
    if (ids.size >= 200) ids.sorted().take(ids.size - 199).forEach(editor::remove)
    val prefix = "$REPLY_CURSOR_PREFIX$scope:"
    val cursors = all.filter { it.key.startsWith(REPLY_CURSOR_PREFIX) && it.value is Long }
    cursors.keys.filter { !it.startsWith(prefix) }.forEach(editor::remove)
    if (target != null && cursor != null) {
        val key = "$prefix$target"
        val other = cursors.filter { it.key.startsWith(prefix) && it.key != key }
        if (other.size >= 200) other.entries.sortedBy { it.value as Long }.take(other.size - 199).forEach { editor.remove(it.key) }
        editor.putLong(key, cursor)
    }
    editor.putBoolean(id, true).apply()
}

private fun replyTag(scope: String, target: String) = "reply:$scope:$target"
private fun unreadTag(scope: String) = "unread:$scope"
private fun unreadGroup(scope: String) = "agent-unread:$scope"

private fun notificationIntent(context: Context, scope: String, kind: String, target: String? = null): PendingIntent {
    val identity = Uri.Builder().scheme("orchestrator").authority("notification").appendPath(scope).appendPath(kind)
        .apply { if (target != null) appendPath(target) }.build()
    val intent = Intent(context, MainActivity::class.java).setAction("io.uggs.orchestrator.OPEN_$kind").setData(identity)
        .putExtra("kind", kind).apply { if (target != null) putExtra("target_id", target) }
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
}

private fun notificationMetadata(scope: String, kind: String, target: String? = null, cursor: Long? = null, pushId: String? = null) = Bundle().apply {
    putString(NOTIFICATION_KIND, kind)
    putString(NOTIFICATION_SCOPE, scope)
    if (target != null) putString(NOTIFICATION_TARGET, target)
    if (cursor != null) putLong(NOTIFICATION_CURSOR, cursor)
    if (pushId != null) putString(NOTIFICATION_PUSH_ID, pushId)
}

private fun StatusBarNotification.isReplyNotification(): Boolean = notification.extras.getString(NOTIFICATION_KIND) in setOf("reply", "unread")

private data class ReplyPush(val target: String, val summary: String, val id: String, val alert: Boolean)

/** An ordinary silent notification counts conversations; launchers exclude group summaries. */
@Synchronized
fun syncUnreadNotifications(context: Context, connection: Connection?, unreadIds: Set<String>) {
    // /me reconciliation owns this scoped policy; startup leaves cached badges untouched.
    saveReplyNotificationPolicy(context, connection)
    reconcileUnreadNotifications(context, connection, unreadIds)
}

private fun reconcileUnreadNotifications(context: Context, connection: Connection?, unreadIds: Set<String>, push: ReplyPush? = null) {
    ensureNotificationChannels(context)
    val manager = context.getSystemService(NotificationManager::class.java)
    val active = manager.activeNotifications.toList()
    val scope = connection?.let { unreadScope(it.server, it.deviceId) }
    val store = connection?.let { UnreadStore(context).apply { activate(it) } }
    // A foreground snapshot may race a newer FCM delivery; always reconcile the current ledger.
    val latest = store?.unreadIds() ?: emptySet()
    val currentUnread = if (latest == unreadIds) unreadIds else latest
    for (entry in active.filter { it.isReplyNotification() }) {
        val extras = entry.notification.extras
        extras.getString(NOTIFICATION_SCOPE)?.let { knownScope ->
            val targets = knownReplyTargets.getOrPut(knownScope) { mutableSetOf() }
            if (extras.getString(NOTIFICATION_KIND) == "reply") extras.getString(NOTIFICATION_TARGET)?.let {
                targets.add(it)
                pendingReplyPosts.remove(knownScope to it)
            }
        }
        if (scope == null || extras.getString(NOTIFICATION_SCOPE) != scope ||
            (extras.getString(NOTIFICATION_KIND) == "reply" && extras.getString(NOTIFICATION_TARGET) !in currentUnread) ||
            (extras.getString(NOTIFICATION_KIND) == "unread" && currentUnread.isEmpty())) {
            manager.cancel(entry.tag, entry.id)
        }
    }
    for ((knownScope, targets) in knownReplyTargets.toMap()) {
        for (target in targets.toList()) if (knownScope != scope || target !in currentUnread) {
            manager.cancel(replyTag(knownScope, target), REPLY_NOTIFICATION_ID)
            pendingReplyPosts.remove(knownScope to target)
            targets.remove(target)
        }
        if (knownScope != scope || currentUnread.isEmpty()) {
            manager.cancel(unreadTag(knownScope), UNREAD_NOTIFICATION_ID)
            knownReplyTargets.remove(knownScope)
        }
    }
    if (scope == null || currentUnread.isEmpty() || !notificationsAllowed(context)) return
    val replies = active.filter {
        it.notification.extras.getString(NOTIFICATION_KIND) == "reply" && it.notification.extras.getString(NOTIFICATION_SCOPE) == scope
    }
    if (channelAllowed(manager, REPLY_ALERT_CHANNEL)) for (target in currentUnread) {
        val existing = replies.filter { it.notification.extras.getString(NOTIFICATION_TARGET) == target }
        // Migrate explicitly marked numeric notifications, preserving unrelated attention/approval messages.
        for (entry in existing.filter { it.tag != replyTag(scope, target) || it.id != REPLY_NOTIFICATION_ID }) manager.cancel(entry.tag, entry.id)
        val current = existing.firstOrNull { it.tag == replyTag(scope, target) && it.id == REPLY_NOTIFICATION_ID }
        val update = push?.takeIf { it.target == target }
        if (current != null && update == null) continue
        if (update == null && pendingReplyPosts[scope to target]?.let { SystemClock.elapsedRealtime() - it < 2_000 } == true) continue
        val text = update?.summary ?: "Open this conversation to read the reply."
        val notification = NotificationCompat.Builder(context, REPLY_ALERT_CHANNEL)
            .setSmallIcon(R.drawable.ic_companion).setContentTitle("Agent reply").setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(notificationIntent(context, scope, "agent", target))
            .setGroup(unreadGroup(scope)).setNumber(0).setAutoCancel(false)
            .setOnlyAlertOnce(update?.alert != true).setSilent(update?.alert != true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .addExtras(notificationMetadata(scope, "reply", target, store?.latestCursor(target), update?.id)).build()
        if (!postNotification(context, replyTag(scope, target), REPLY_NOTIFICATION_ID, notification)) return
        knownReplyTargets.getOrPut(scope) { mutableSetOf() }.add(target)
        pendingReplyPosts[scope to target] = SystemClock.elapsedRealtime()
    }
    if (!channelAllowed(manager, UNREAD_BADGE_CHANNEL)) return
    val summary = active.firstOrNull { it.tag == unreadTag(scope) && it.id == UNREAD_NOTIFICATION_ID }
    if (summary?.notification?.number == currentUnread.size) return
    val count = currentUnread.size
    val text = if (count == 1) "1 conversation with an unread reply." else "$count conversations with unread replies."
    val notification = NotificationCompat.Builder(context, UNREAD_BADGE_CHANNEL)
        .setSmallIcon(R.drawable.ic_companion).setContentTitle("Unread agent replies").setContentText(text)
        .setContentIntent(notificationIntent(context, scope, "unread"))
        .setNumber(count).setAutoCancel(false)
        .setOnlyAlertOnce(true).setSilent(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .addExtras(notificationMetadata(scope, "unread")).build()
    if (!postNotification(context, unreadTag(scope), UNREAD_NOTIFICATION_ID, notification)) return
    knownReplyTargets.getOrPut(scope) { mutableSetOf() }
}

@Synchronized
internal fun showCompanionNotification(context: Context, data: Map<String, String>) {
    val connection = ConnectionStore(context).load() ?: return
    if (data["device_id"] != connection.deviceId) return
    val id = data["notification_id"]?.takeIf { it.isNotBlank() && it.length <= 256 } ?: return
    val target = data["target_id"]?.takeIf { it.isNotBlank() && it.length <= 256 } ?: return
    val scope = unreadScope(connection.server, connection.deviceId)
    val seen = context.getSharedPreferences("push-seen", Context.MODE_PRIVATE)
    if (data["kind"] == "reply") {
        val store = UnreadStore(context).apply { activate(connection) }
        val cursor = data["event_cursor"]?.toLongOrNull()?.takeIf { it > 0 }
        if (data.containsKey("event_cursor") && cursor == null) return
        val previousCursor = store.latestCursor(target) ?: 0
        val deliveredCursor = seen.getLong("$REPLY_CURSOR_PREFIX$scope:$target", 0)
        val unseen = !seen.contains("$scope:$id")
        if (cursor == null && !unseen) {
            reconcileUnreadNotifications(context, if (replyNotificationsEnabled(context, scope)) connection else null, store.unreadIds())
            return
        }
        val unread = store.observePush(target, cursor, id)
        val advanced = if (cursor == null) unseen else unseen && cursor >= previousCursor && cursor > deliveredCursor
        rememberPush(seen, scope, "$scope:$id", target, cursor?.takeIf { advanced })
        if (!replyNotificationsEnabled(context, scope)) {
            reconcileUnreadNotifications(context, null, emptySet())
            return
        }
        val update = if (unread && advanced) ReplyPush(target, compactSummary(data["summary"]) ?: "New reply from the agent.",
            id, VisibleConversation.session != target) else null
        reconcileUnreadNotifications(context, connection, store.unreadIds(), update)
        return
    }
    val approval = data["kind"] == "approval"
    if (!approval && VisibleConversation.session == target) return
    ensureNotificationChannels(context)
    val channel = if (approval) "approvals" else "agents"
    if (!notificationsAllowed(context) || !channelAllowed(context.getSystemService(NotificationManager::class.java), channel)) return
    if (seen.contains(id)) return
    val summary = if (approval) "Open to review and approve or deny." else compactSummary(data["summary"]) ?: "Agent attention requested."
    val notification = NotificationCompat.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_companion).setContentTitle(if (approval) "Host access requested" else "Agent update")
        .setContentText(summary).setStyle(NotificationCompat.BigTextStyle().bigText(summary))
        .setContentIntent(notificationIntent(context, scope, if (approval) "approval" else "agent", target))
        .setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
    if (postNotification(context, null, id.hashCode(), notification)) rememberPush(seen, scope, id)
}
