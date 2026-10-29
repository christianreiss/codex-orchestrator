package io.uggs.orchestrator

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The process's one [ChatOutbox] and its writer. The view model and notification actions
 * (which may run while no activity exists) share it, so there is exactly one in-memory list
 * and one ordered writer for `chat-outbox.bin`. Use it on the main thread only.
 */
internal class OutboxHub private constructor(context: Context) {
    private val store = ChatCacheStore(context, ChatOutbox.FILE, ChatOutbox.MAX_BYTES)
    val writer = ChatCacheWriter(store)
    val outbox = ChatOutbox()
    /** Ids with a request in flight, from either the view model or a notification action. */
    val inFlight: MutableSet<String> = java.util.Collections.synchronizedSet(mutableSetOf())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val started = CompletableDeferred<Unit>()
    private var bound: Pair<String, Deferred<Unit>>? = null
    private val changes = CopyOnWriteArrayList<() -> Unit>()
    private val deliveries = CopyOnWriteArrayList<(OutboxEntry, JSONObject) -> Unit>()

    init {
        outbox.onChange = { writer.persistBody(outbox.json()); changes.forEach { it() } }
        scope.launch(Dispatchers.IO) { started.complete(Unit); writer.drain() }
    }

    /**
     * Binds the outbox to the pairing [owner] and merges its saved blob once; the returned job
     * completes when that is done. A blank owner (no pairing) empties it and deletes the file.
     */
    fun bind(owner: String): Deferred<Unit> {
        bound?.takeIf { it.first == owner }?.let { return it.second }
        if (outbox.owner != owner) outbox.reset(owner)
        val wipes = outbox.wipes
        val job = scope.async {
            started.await()
            writer.flush()
            if (owner.isBlank()) { writer.delete(); return@async }
            val saved = withContext(Dispatchers.IO) { store.read() }
            if (outbox.owner == owner && outbox.wipes == wipes) outbox.restore(owner, saved)
        }
        bound = owner to job
        return job
    }

    fun onChange(listener: () -> Unit): () -> Unit { changes.add(listener); return { changes.remove(listener) } }
    /** Sends a notification action confirmed while the app may not have been looking. */
    fun onDelivered(listener: (OutboxEntry, JSONObject) -> Unit): () -> Unit { deliveries.add(listener); return { deliveries.remove(listener) } }
    fun delivered(entry: OutboxEntry, response: JSONObject) = deliveries.forEach { it(entry, response) }

    companion object {
        @Volatile private var instance: OutboxHub? = null
        fun get(context: Context): OutboxHub = instance ?: synchronized(this) { instance ?: OutboxHub(context.applicationContext).also { instance = it } }
    }
}
