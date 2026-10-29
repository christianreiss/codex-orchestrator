package io.uggs.orchestrator

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/** Process-wide events from pushes and notification actions that an open app reflects at once. */
internal object CompanionSignals {
    /** A room was read elsewhere (another device or a notification): room id and `read_at`. */
    val roomRead = MutableSharedFlow<Pair<String, String?>>(extraBufferCapacity = 16)
}

private const val REMOTE_INPUT_REPLY = "io.uggs.orchestrator.reply_text"
/** One notification action must finish inside its broadcast. */
private const val ACTION_CALL_TIMEOUT_MS = 7_000L
private const val ACTION_BUDGET_MS = 9_000L

/** MessagingStyle with the operator as the device user; each line names its sender. */
internal fun conversationStyle(context: Context, title: String?, group: Boolean, lines: List<NotificationLine>): NotificationCompat.MessagingStyle {
    val self = Person.Builder().setKey("self").setName(context.getString(R.string.notif_you)).build()
    val style = NotificationCompat.MessagingStyle(self).setGroupConversation(group)
    if (group && title != null) style.setConversationTitle(title)
    lines.forEach { line ->
        val sender = Person.Builder().setName(line.sender ?: context.getString(R.string.chat_agent_default)).build()
        style.addMessage(line.text, line.time, sender)
    }
    return style
}

/** Opens the conversation through its `orchestrator://chat/{key}` deep link. */
internal fun conversationIntent(context: Context, key: ConversationKey): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(Routes.deepLink(key)), context, MainActivity::class.java)
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
}

/** Adds the [pushActions] of [push] to a notification posted as [tag]/[id]. */
internal fun addConversationActions(context: Context, builder: NotificationCompat.Builder, scope: String, tag: String?, id: Int, push: ConversationPush) {
    pushActions(push).forEachIndexed { index, action ->
        val request = NotificationActionRequest(action.kind, scope, tag, id, push, action.option)
        val identity = "$tag:$id:${action.kind}:$index"
        val intent = Intent(context, NotificationActionReceiver::class.java).setAction("io.uggs.orchestrator.NOTIFICATION_${action.kind.name.uppercase()}")
            .setData(Uri.Builder().scheme("orchestrator").authority("action").appendPath(identity.hashCode().toString()).build())
        request.extras().forEach { (key, value) -> intent.putExtra(key, value) }
        // RemoteInput writes the typed text into the intent, so only Reply is mutable (explicit component).
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (action.kind == PushActionKind.Reply) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getBroadcast(context, identity.hashCode(), intent, flags)
        builder.addAction(when (action.kind) {
            PushActionKind.Reply -> NotificationCompat.Action.Builder(R.drawable.ic_companion, context.getString(R.string.notif_action_reply), pending)
                .addRemoteInput(RemoteInput.Builder(REMOTE_INPUT_REPLY).setLabel(context.getString(R.string.notif_action_reply_hint)).build())
                .setAllowGeneratedReplies(false).setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).setShowsUserInterface(false).build()
            PushActionKind.MarkRead -> NotificationCompat.Action.Builder(R.drawable.ic_companion, context.getString(R.string.notif_action_mark_read), pending)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ).setShowsUserInterface(false).build()
            PushActionKind.Answer -> NotificationCompat.Action.Builder(R.drawable.ic_companion, action.option!!.label, pending).setShowsUserInterface(false).build()
        })
    }
}

/**
 * Reply, answer and "Mark read" from a notification. A reply or answer is queued in the shared
 * [ChatOutbox] (persisted before its request, with a stable id) and tried once here; if that
 * attempt does not confirm it, the app retries it like any composer send.
 */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val extras = intent.extras ?: return
        val request = NotificationActionRequest.parse(extras.keySet().associateWith { extras.getString(it) }) ?: return
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(REMOTE_INPUT_REPLY)?.toString()
        val app = context.applicationContext
        val result = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).launch {
            try {
                val done = withTimeoutOrNull(ACTION_BUDGET_MS) { handleNotificationAction(app, request, text) }
                if (done == false || (done == null && request.action != PushActionKind.MarkRead)) notifyNotSent(app, request)
            } catch (_: Exception) {
                if (request.action != PushActionKind.MarkRead) notifyNotSent(app, request)
            } finally { result.finish() }
        }
    }
}

/** True when the action is complete; false when a send waits in the outbox. */
private suspend fun handleNotificationAction(context: Context, request: NotificationActionRequest, text: String?): Boolean {
    val connection = ConnectionStore(context).load()
    val manager = context.getSystemService(NotificationManager::class.java)
    if (connection == null || unreadScope(connection.server, connection.deviceId) != request.scope) {
        manager.cancel(request.tag, request.id); return true
    }
    if (request.action == PushActionKind.MarkRead) { markReadFromNotification(context, connection, request); return true }
    val now = java.time.Instant.now().toString()
    val entry = when (request.action) {
        PushActionKind.Reply -> notificationReplyEntry(request.push, text.orEmpty(), now)
        else -> request.option?.let { notificationAnswerEntry(request.push, it, now) }
    } ?: return true
    val hub = OutboxHub.get(context)
    val owner = ChatHistoryCache.owner(connection)
    hub.bind(owner).await()
    if (hub.outbox.owner != owner) return false
    val queued = hub.outbox.entry(entry.id) ?: entry.also(hub.outbox::enqueue)
    hub.writer.flush()
    if (!hub.inFlight.add(queued.id)) return false
    val accepted = try {
        when (val result = deliverOutboxEntry(Api(connection.server, connection.token, ContextTexts(context), ACTION_CALL_TIMEOUT_MS), queued)) {
            is OutboxResult.Accepted -> { hub.outbox.remove(queued.id); hub.delivered(queued, result.response); true }
            is OutboxResult.Rejected -> { hub.outbox.update(queued.id) { it.afterFailure(result, SystemClock.elapsedRealtime()) }; false }
        }
    } finally { hub.inFlight.remove(queued.id) }
    // Answering is reading: the alert goes away like on a messenger.
    if (accepted) markReadFromNotification(context, connection, request)
    return accepted
}

/** Rooms: `/rooms/seen` through the newest notified event. Direct chats: the local read ledger, synced on the next snapshot. */
private suspend fun markReadFromNotification(context: Context, connection: Connection, request: NotificationActionRequest) {
    val manager = context.getSystemService(NotificationManager::class.java)
    when (val key = request.push.key) {
        is ConversationKey.Room -> {
            manager.cancel(request.tag, request.id)
            val through = request.push.ts ?: return
            runCatching {
                Api(connection.server, connection.token, null, ACTION_CALL_TIMEOUT_MS).request("/rooms/seen", "POST", JSONObject().put("room_id", key.roomId).put("through", through))
                CompanionSignals.roomRead.tryEmit(key.roomId to through)
            }
        }
        is ConversationKey.Direct -> {
            request.push.eventCursor?.let { cursor -> UnreadStore(context).apply { activate(connection) }.markRead(key.agentId, cursor) }
            manager.cancel(request.tag, request.id)
            refreshReplyNotifications(context, connection)
        }
    }
}

/** Replaces the alert whose reply is still unconfirmed, so the reply field does not spin and the operator knows. */
private fun notifyNotSent(context: Context, request: NotificationActionRequest) {
    val channel = when (request.push.kind) { "room" -> ROOM_CHANNEL; "reply" -> REPLY_ALERT_CHANNEL; else -> "agents" }
    val notification = NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_companion)
        .setContentTitle(request.push.title ?: request.push.sender ?: context.getString(R.string.title_conversation))
        .setContentText(context.getString(R.string.notif_reply_not_sent))
        .setContentIntent(conversationIntent(context, request.push.key))
        .setOnlyAlertOnce(true).setSilent(true).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
    postNotification(context, request.tag, request.id, notification)
}
