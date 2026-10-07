package io.uggs.orchestrator

import android.Manifest
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("approvals", "Host access", NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel("agents", "Agent conversations", NotificationManager.IMPORTANCE_HIGH))
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

internal fun showCompanionNotification(context: Context, data: Map<String, String>) {
        val connection = ConnectionStore(context).load() ?: return
        if (data["device_id"] != connection.deviceId) return
        val id = data["notification_id"] ?: return
        val target = data["target_id"] ?: return
        val approval = data["kind"] == "approval"
        if (!approval && VisibleConversation.session == target) return
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        if (android.os.Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val seen = context.getSharedPreferences("push-seen", Context.MODE_PRIVATE)
        if (seen.contains(id)) return
        if (seen.all.size > 200) seen.edit().clear().apply()
        val intent = Intent(context, MainActivity::class.java).putExtra("kind", if (approval) "approval" else "agent").putExtra("target_id", target)
        val pending = PendingIntent.getActivity(context, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val summary = if (approval) "Open to review and approve or deny." else compactSummary(data["summary"]) ?: "New reply from the agent."
        val notification = NotificationCompat.Builder(context, if (approval) "approvals" else "agents")
            .setSmallIcon(R.drawable.ic_companion).setContentTitle(if (approval) "Host access requested" else "Agent update")
            .setContentText(summary).setStyle(NotificationCompat.BigTextStyle().bigText(summary))
            .setContentIntent(pending).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
        NotificationManagerCompat.from(context).notify(id.hashCode(), notification)
        seen.edit().putBoolean(id, true).apply()
}
