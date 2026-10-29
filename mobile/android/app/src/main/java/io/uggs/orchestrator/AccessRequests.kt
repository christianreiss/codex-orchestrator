package io.uggs.orchestrator

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject

/** Insecure-host authorization requests and open host/fleet windows (`/approvals`). */
internal class AccessRequests {
    var approvals by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var activeWindows by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var fleetWindow by mutableStateOf<JSONObject?>(null); private set
    var defaultMinutes by mutableStateOf(480); private set

    /** Applies one `/approvals` snapshot; null means the device may not read it. */
    fun apply(requests: JSONObject?) {
        approvals = requests?.getJSONArray("requests")?.objects()?.filter { it.optBoolean("live") } ?: emptyList()
        activeWindows = requests?.optJSONArray("active_windows")?.objects() ?: emptyList()
        fleetWindow = requests?.optJSONObject("fleet_window")
        defaultMinutes = requests?.optInt("default_duration_minutes", 480) ?: 480
    }
    fun decided(id: Long) { approvals = approvals.filterNot { it.optLong("id") == id } }
    fun windowClosed(hostId: Long) { activeWindows = activeWindows.filterNot { it.optLong("host_id") == hostId } }
    /** On disconnect. [defaultMinutes] keeps its last value, as before. */
    fun clear() { approvals = emptyList(); activeWindows = emptyList(); fleetWindow = null }
}
