package io.uggs.orchestrator

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Observable unread replies per direct chat, mirrored into the unread notifications. */
internal class UnreadState(private val app: Application, private val store: UnreadStore) {
    var sessions by mutableStateOf<Set<String>>(emptySet()); private set
    private var replyCounts by mutableStateOf<Map<String, Int>>(emptyMap())
    fun replyCount(id: String) = replyCounts[id] ?: 0

    /**
     * [visible]: transcripts may be shown. [notify]: null leaves notifications
     * untouched (permissions unknown); otherwise whether they may be shown.
     */
    fun refresh(visible: Boolean, notify: Boolean?, connection: Connection?) {
        sessions = if (!visible) emptySet() else store.unreadIds()
        replyCounts = sessions.associateWith(store::unreadReplyCount)
        if (notify != null) syncUnreadNotifications(app, if (notify) connection else null, if (notify) sessions else emptySet())
    }
    fun reset() { sessions = emptySet(); replyCounts = emptyMap() }
}
