package io.uggs.orchestrator

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Single ordered writer for one encrypted blob. Writes are conflated:
 * only the newest body matters, and `null` deletes the file.
 */
internal class ChatCacheWriter(private val store: ChatCacheStore) {
    private val writes = Channel<Pair<Long, String?>>(Channel.CONFLATED)
    private var lastBody: String? = null
    @Volatile private var queued = 0L
    private val written = MutableStateFlow(0L)
    /** Changes whenever the cache is discarded, fencing a restore that started earlier. */
    var epoch = 0L; private set

    fun read(): String? = store.read()
    fun persist(cache: ChatHistoryCache, force: Boolean = false) = persistBody(cache.takeIf { it.agents().isNotEmpty() }?.json(), force)
    /** Queues [body] as the new blob; `null` deletes it. */
    fun persistBody(body: String?, force: Boolean = false) {
        if (force || body != lastBody) { lastBody = body; queue(body) }
    }
    fun discard() { epoch++; lastBody = null; queue(null) }
    fun delete() = queue(null)
    private fun queue(body: String?) { writes.trySend(++queued to body) }
    /** Waits until everything queued so far is on disk (bounded, so a stopped writer never blocks a send). */
    suspend fun flush(timeoutMs: Long = 2_000) {
        val target = queued
        withTimeoutOrNull(timeoutMs) { written.first { it >= target } }
    }
    /** Runs until [close]; a single writer preserves order across refresh, revocation and re-pairing. */
    suspend fun drain() { for ((sequence, body) in writes) { runCatching { store.write(body) }; written.value = sequence } }
    fun close() { writes.close() }
}
