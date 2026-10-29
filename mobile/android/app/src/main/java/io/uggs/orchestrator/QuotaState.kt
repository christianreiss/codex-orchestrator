package io.uggs.orchestrator

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

/**
 * Provider quota snapshot. [fence] identifies the connection and live
 * generation; a result is only applied while it is unchanged.
 */
internal class QuotaState(
    private val api: () -> Api,
    private val active: () -> Boolean,
    private val permitted: () -> Boolean,
    private val fence: () -> Any?,
) {
    var engines by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var error by mutableStateOf<String?>(null); private set
    var loading by mutableStateOf(false); private set
    private val mutex = Mutex()

    suspend fun refresh() = mutex.withLock {
        if (!active() || !permitted()) return
        val owner = fence()
        loading = true
        try {
            val snapshot = api().request("/quotas")
            if (fence() == owner && permitted()) {
                engines = snapshot.getJSONArray("engines").objects(); error = null
            }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            if (fence() == owner) {
                error = if (e is ApiException && e.status == 404) "Quotas require a server update." else "Could not refresh quotas. Try again."
                if (e is ApiException && e.status in setOf(401, 403)) engines = emptyList()
            }
        } finally { loading = false }
    }
    fun clear() { engines = emptyList(); error = null }
}
