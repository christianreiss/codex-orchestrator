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

object PushStatus { val state = MutableStateFlow(R.string.push_not_configured) }

fun configurePush(context: Context, connection: Connection) {
    val config = connection.firebase ?: return
    PushStatus.state.value = R.string.push_registering
    try {
        val existing = FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
        if (existing != null && existing.options.applicationId != config.getString("app_id")) existing.delete()
        if (FirebaseApp.getApps(context).none { it.name == FirebaseApp.DEFAULT_APP_NAME }) {
            FirebaseApp.initializeApp(context, FirebaseOptions.Builder().setApplicationId(config.getString("app_id"))
                .setApiKey(config.getString("api_key")).setGcmSenderId(config.getString("sender_id")).setProjectId(config.getString("project_id")).build())
        }
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> registerPushToken(context, token) }
            .addOnFailureListener { PushStatus.state.value = R.string.push_firebase_failed }
    } catch (_: Exception) { PushStatus.state.value = R.string.push_config_failed }
}

private fun registerPushToken(context: Context, token: String) {
    val connection = ConnectionStore(context).load() ?: return
    CoroutineScope(Dispatchers.IO).launch {
        runCatching { Api(connection.server, connection.token).request("/device", "PATCH", JSONObject().put("fcm_token", token).put("read_sync_protocol", 1)) }
            .onSuccess { PushStatus.state.value = R.string.push_registered }
            .onFailure { PushStatus.state.value = R.string.push_register_failed }
    }
}

object VisibleConversation { @Volatile var session: String? = null }

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { registerPushToken(this, token) }
    override fun onMessageReceived(message: RemoteMessage) { showCompanionNotification(this, message.data) }
}

internal const val REPLY_ALERT_CHANNEL = "agent-replies"
internal const val ROOM_CHANNEL = "rooms"
internal const val QUOTA_CHANNEL = "quota-warnings"
private const val QUOTA_NOTIFICATION_ID = 4
internal const val UNREAD_BADGE_CHANNEL = "unread-replies"
internal const val NOTIFICATION_KIND = "io.uggs.orchestrator.kind"
internal const val NOTIFICATION_SCOPE = "io.uggs.orchestrator.scope"
internal const val NOTIFICATION_TARGET = "io.uggs.orchestrator.target"
/** Where the unread summary opens when exactly one chat is unread; kept apart from [NOTIFICATION_TARGET], which marks per-chat reply alerts. */
private const val NOTIFICATION_OPEN_TARGET = "io.uggs.orchestrator.open_target"
internal const val NOTIFICATION_CURSOR = "io.uggs.orchestrator.cursor"
internal const val NOTIFICATION_PUSH_ID = "io.uggs.orchestrator.push_id"
private const val REPLY_NOTIFICATION_ID = 1
private const val UNREAD_NOTIFICATION_ID = 2
internal const val ROOM_NOTIFICATION_ID = 3
/** Newest room event time a room notification covers: "Mark read" sends it as `through`. */
private const val NOTIFICATION_ROOM_THROUGH = "io.uggs.orchestrator.room_through"
private const val REPLY_POLICY_PREFERENCES = "reply-notification-policy"
private const val REPLY_CURSOR_PREFIX = "reply-cursor:"
// Android enqueues notify() asynchronously. Track IDs until activeNotifications catches up,
// so a read immediately following a push can also cancel an in-flight notification.
private val knownReplyTargets = mutableMapOf<String, MutableSet<String>>()

internal fun ensureNotificationChannels(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    // Existing channels retain the operator's notification preferences.
    manager.createNotificationChannel(NotificationChannel("approvals", context.getString(R.string.channel_approvals), NotificationManager.IMPORTANCE_HIGH))
    manager.createNotificationChannel(NotificationChannel("agents", context.getString(R.string.channel_agents), NotificationManager.IMPORTANCE_HIGH))
    manager.createNotificationChannel(NotificationChannel(REPLY_ALERT_CHANNEL, context.getString(R.string.channel_replies), NotificationManager.IMPORTANCE_HIGH).apply {
        description = context.getString(R.string.channel_replies_desc)
        setShowBadge(false)
    })
    manager.createNotificationChannel(NotificationChannel(UNREAD_BADGE_CHANNEL, context.getString(R.string.channel_unread), NotificationManager.IMPORTANCE_LOW).apply {
        description = context.getString(R.string.channel_unread_desc)
        setShowBadge(true)
        setSound(null, null)
        enableVibration(false)
    })
    manager.createNotificationChannel(NotificationChannel(QUOTA_CHANNEL, context.getString(R.string.channel_quota), NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = context.getString(R.string.channel_quota_desc)
    })
    manager.createNotificationChannel(NotificationChannel(ROOM_CHANNEL, context.getString(R.string.channel_rooms), NotificationManager.IMPORTANCE_HIGH).apply {
        description = context.getString(R.string.channel_rooms_desc)
    })
}

internal fun notificationsAllowed(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled() &&
    (android.os.Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

internal fun channelAllowed(manager: NotificationManager, channel: String): Boolean =
    manager.getNotificationChannel(channel)?.importance != NotificationManager.IMPORTANCE_NONE

internal fun postNotification(context: Context, tag: String?, id: Int, notification: Notification): Boolean {
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

internal fun replyNotificationsEnabled(context: Context, scope: String): Boolean {
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

internal fun replyTag(scope: String, target: String) = "reply:$scope:$target"
internal fun roomTag(scope: String, roomId: String) = "room:$scope:$roomId"
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

private data class ReplyPush(val target: String, val summary: String, val id: String, val alert: Boolean, val push: ConversationPush? = null)

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
            }
        }
        if (scope == null || extras.getString(NOTIFICATION_SCOPE) != scope ||
            (extras.getString(NOTIFICATION_KIND) == "reply" && (extras.getString(NOTIFICATION_TARGET) !in currentUnread ||
                extras.getString(NOTIFICATION_PUSH_ID).isNullOrBlank())) ||
            (extras.getString(NOTIFICATION_KIND) == "unread" && currentUnread.isEmpty())) {
            manager.cancel(entry.tag, entry.id)
        }
    }
    for ((knownScope, targets) in knownReplyTargets.toMap()) {
        for (target in targets.toList()) if (knownScope != scope || target !in currentUnread) {
            manager.cancel(replyTag(knownScope, target), REPLY_NOTIFICATION_ID)
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
        // Snapshot reconciliation only updates the badge. Session alerts require a real push.
        val update = push?.takeIf { it.target == target } ?: continue
        val existing = replies.filter { it.notification.extras.getString(NOTIFICATION_TARGET) == target }
        // Migrate explicitly marked numeric notifications, preserving unrelated attention/approval messages.
        for (entry in existing.filter { it.tag != replyTag(scope, target) || it.id != REPLY_NOTIFICATION_ID }) manager.cancel(entry.tag, entry.id)
        val text = update.summary
        val sender = update.push?.sender ?: update.push?.title ?: context.getString(R.string.notif_agent_reply)
        val builder = NotificationCompat.Builder(context, REPLY_ALERT_CHANNEL)
            .setSmallIcon(R.drawable.ic_companion).setContentTitle(context.getString(R.string.notif_agent_reply)).setContentText(text)
            .setStyle(conversationStyle(context, null, false, listOf(NotificationLine(sender, text, update.push?.time?.toEpochMilli() ?: System.currentTimeMillis()))))
            .setContentIntent(conversationIntent(context, ConversationKey.Direct(target)))
            .setGroup(unreadGroup(scope)).setNumber(0).setAutoCancel(false)
            .setOnlyAlertOnce(!update.alert).setSilent(!update.alert)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .addExtras(notificationMetadata(scope, "reply", target, store?.latestCursor(target), update.id))
        update.push?.let { addConversationActions(context, builder, scope, replyTag(scope, target), REPLY_NOTIFICATION_ID, it) }
        val notification = builder.build()
        if (!postNotification(context, replyTag(scope, target), REPLY_NOTIFICATION_ID, notification)) return
        knownReplyTargets.getOrPut(scope) { mutableSetOf() }.add(target)
    }
    if (!channelAllowed(manager, UNREAD_BADGE_CHANNEL)) return
    val summary = active.firstOrNull { it.tag == unreadTag(scope) && it.id == UNREAD_NOTIFICATION_ID }
    val onlyUnread = currentUnread.singleOrNull()
    if (summary?.notification?.number == currentUnread.size && summary.notification.extras.getString(NOTIFICATION_OPEN_TARGET) == onlyUnread) return
    val count = currentUnread.size
    val text = context.resources.getQuantityString(R.plurals.notif_unread_text, count, count)
    val notification = NotificationCompat.Builder(context, UNREAD_BADGE_CHANNEL)
        .setSmallIcon(R.drawable.ic_companion).setContentTitle(context.getString(R.string.notif_unread_title)).setContentText(text)
        .setContentIntent(notificationIntent(context, scope, "unread", onlyUnread))
        .setNumber(count).setAutoCancel(false)
        .setOnlyAlertOnce(true).setSilent(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .addExtras(notificationMetadata(scope, "unread")).addExtras(Bundle().apply { if (onlyUnread != null) putString(NOTIFICATION_OPEN_TARGET, onlyUnread) }).build()
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
    if (data["kind"] == "read") {
        val cursor = data["event_cursor"]?.toLongOrNull()?.takeIf { it > 0 } ?: return
        val store = UnreadStore(context)
        if (!store.observeSharedRead(connection, target, cursor)) return
        reconcileUnreadNotifications(context, if (replyNotificationsEnabled(context, scope)) connection else null, store.unreadIds())
        return
    }
    if (data["kind"] == "room_read") {
        // Read on another device: this room's alert and its unread badge go.
        val room = data["room_id"]?.takeIf { it.isNotBlank() && it.length <= 256 } ?: target
        context.getSystemService(NotificationManager::class.java).cancel(roomTag(scope, room), ROOM_NOTIFICATION_ID)
        CompanionSignals.roomRead.tryEmit(room to data["read_at"]?.takeIf { it.isNotBlank() })
        return
    }
    if (data["kind"] == "quota") {
        val push = parseQuotaPush(data) ?: return
        showQuotaNotification(context, scope, push, seen)
        return
    }
    if (data["kind"] == "room") {
        val push = parseConversationPush(data) ?: return
        showRoomNotification(context, scope, push, seen)
        return
    }
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
        val update = if (unread && advanced) ReplyPush(target, compactSummary(data["summary"]) ?: context.getString(R.string.notif_new_reply),
            id, VisibleConversation.session != target, parseConversationPush(data)) else null
        reconcileUnreadNotifications(context, connection, store.unreadIds(), update)
        return
    }
    val approval = data["kind"] == "approval"
    if (!approval && VisibleConversation.session == target) return
    ensureNotificationChannels(context)
    val channel = if (approval) "approvals" else "agents"
    if (!notificationsAllowed(context) || !channelAllowed(context.getSystemService(NotificationManager::class.java), channel)) return
    if (seen.contains(id)) return
    val summary = if (approval) context.getString(R.string.notif_approval_summary) else compactSummary(data["summary"]) ?: context.getString(R.string.notif_attention)
    val severity = data["severity"]?.takeIf { it in setOf("important","critical","blocker") }
    val title = if (approval) context.getString(R.string.notif_approval_title)
        else if (severity != null) context.getString(R.string.notif_needs_you, context.getString(when (severity) {
            "important" -> R.string.severity_important; "critical" -> R.string.severity_critical; else -> R.string.severity_blocker
        })) else context.getString(R.string.notif_agent_update)
    val builder = NotificationCompat.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_companion).setContentTitle(title)
        .setContentText(summary).setStyle(NotificationCompat.BigTextStyle().bigText(summary))
        .setContentIntent(if (approval) notificationIntent(context, scope, "approval", target) else conversationIntent(context, ConversationKey.Direct(target)))
        .setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
    // Approvals only open the app: nothing is allowed from the lock screen.
    if (!approval) parseConversationPush(data)?.let { addConversationActions(context, builder, scope, null, id.hashCode(), it) }
    if (postNotification(context, null, id.hashCode(), builder.build())) rememberPush(seen, scope, id)
}

/**
 * One conversation notification per room (MessagingStyle, newest [ROOM_NOTIFICATION_HISTORY]
 * pushes). Suppressed while the room is on screen; the server also skips visible rooms.
 */
private fun showRoomNotification(context: Context, scope: String, push: ConversationPush, seen: SharedPreferences) {
    val roomId = push.targetId
    val seenKey = "$scope:${push.notificationId}"
    if (seen.contains(seenKey)) return
    if (VisibleConversation.session == roomId || !replyNotificationsEnabled(context, scope)) { rememberPush(seen, scope, seenKey); return }
    ensureNotificationChannels(context)
    val manager = context.getSystemService(NotificationManager::class.java)
    if (!notificationsAllowed(context) || !channelAllowed(manager, ROOM_CHANNEL)) return
    val tag = roomTag(scope, roomId)
    val existing = manager.activeNotifications.firstOrNull { it.tag == tag && it.id == ROOM_NOTIFICATION_ID }?.notification
    val history = existing?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }?.messages.orEmpty()
        .map { NotificationLine(it.person?.name?.toString(), it.text?.toString().orEmpty(), it.timestamp) }
    val time = push.time?.toEpochMilli() ?: System.currentTimeMillis()
    val lines = appendNotificationLine(history, NotificationLine(push.sender ?: context.getString(R.string.chat_agent_default), push.summary ?: context.getString(R.string.notif_room_message), time))
    // Mark read covers the newest event any of the merged pushes named.
    val through = listOfNotNull(existing?.extras?.getString(NOTIFICATION_ROOM_THROUGH), push.ts).maxOrNull()
    val covered = push.copy(ts = through)
    val builder = NotificationCompat.Builder(context, ROOM_CHANNEL)
        .setSmallIcon(R.drawable.ic_companion).setContentTitle(push.title ?: context.getString(R.string.title_conversation))
        .setContentText(lines.last().text)
        .setStyle(conversationStyle(context, push.title, true, lines))
        .setContentIntent(conversationIntent(context, push.key))
        .setCategory(NotificationCompat.CATEGORY_MESSAGE).setAutoCancel(true)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .addExtras(notificationMetadata(scope, "room", roomId, pushId = push.notificationId))
        .addExtras(Bundle().apply { through?.let { putString(NOTIFICATION_ROOM_THROUGH, it) } })
    addConversationActions(context, builder, scope, tag, ROOM_NOTIFICATION_ID, covered)
    if (postNotification(context, tag, ROOM_NOTIFICATION_ID, builder.build())) rememberPush(seen, scope, seenKey)
}

/** One quota warning per account window (Quota warnings channel); tapping opens the Quotas tab. */
private fun showQuotaNotification(context: Context, scope: String, push: QuotaPush, seen: SharedPreferences) {
    val seenKey = "$scope:${push.notificationId}"
    if (seen.contains(seenKey)) return
    ensureNotificationChannels(context)
    val manager = context.getSystemService(NotificationManager::class.java)
    if (!notificationsAllowed(context) || !channelAllowed(manager, QUOTA_CHANNEL)) return
    val t = ContextTexts(context)
    val text = quotaPushText(t, push)
    val builder = NotificationCompat.Builder(context, QUOTA_CHANNEL)
        .setSmallIcon(R.drawable.ic_companion).setContentTitle(quotaPushTitle(t, push)).setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setContentIntent(notificationIntent(context, scope, "quota", push.accountId))
        .setCategory(NotificationCompat.CATEGORY_STATUS).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .addExtras(notificationMetadata(scope, "quota", push.accountId, pushId = push.notificationId))
    push.accountLabel?.let { builder.setSubText(it) }
    if (postNotification(context, quotaNotificationTag(scope, push), QUOTA_NOTIFICATION_ID, builder.build())) rememberPush(seen, scope, seenKey)
}

/** A room left on screen or read elsewhere has no reason to keep its notification. */
internal fun cancelRoomNotification(context: Context, connection: Connection, roomId: String) {
    context.getSystemService(NotificationManager::class.java).cancel(roomTag(unreadScope(connection.server, connection.deviceId), roomId), ROOM_NOTIFICATION_ID)
}

/** Re-applies the unread ledger to reply alerts, e.g. after "Mark read" from a notification. */
@Synchronized
internal fun refreshReplyNotifications(context: Context, connection: Connection) {
    val scope = unreadScope(connection.server, connection.deviceId)
    reconcileUnreadNotifications(context, if (replyNotificationsEnabled(context, scope)) connection else null, UnreadStore(context).unreadIds())
}
