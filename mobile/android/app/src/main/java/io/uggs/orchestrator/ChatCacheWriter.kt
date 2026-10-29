package io.uggs.orchestrator

import kotlinx.coroutines.channels.Channel

/**
 * Single ordered writer for the encrypted chat cache. Writes are conflated:
 * only the newest body matters, and `null` deletes the file.
 */
internal class ChatCacheWriter(private val store: ChatCacheStore) {
    private val writes = Channel<String?>(Channel.CONFLATED)
    private var lastBody: String? = null
    /** Changes whenever the cache is discarded, fencing a restore that started earlier. */
    var epoch = 0L; private set

    fun read(): String? = store.read()
    fun persist(cache: ChatHistoryCache, force: Boolean = false) {
        val body = cache.takeIf { it.agents().isNotEmpty() }?.json()
        if (force || body != lastBody) { lastBody = body; writes.trySend(body) }
    }
    fun discard() { epoch++; lastBody = null; writes.trySend(null) }
    fun delete() { writes.trySend(null) }
    /** Runs until [close]; a single writer preserves order across refresh, revocation and re-pairing. */
    suspend fun drain() { for (body in writes) runCatching { store.write(body) } }
    fun close() { writes.close() }
}
