package io.uggs.orchestrator

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID

/** Upload and download endpoint for a conversation key: an agent id, or `room:<id>`. */
internal fun attachmentBase(session: String) = if (session.startsWith("room:")) "/rooms/${session.removePrefix("room:")}/attachments" else "/agents/$session/attachments"

private suspend fun sha256Hex(file: java.io.File): String = withContext(Dispatchers.IO) {
    val hash = java.security.MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val count = input.read(buffer); if (count < 0) break; hash.update(buffer, 0, count) } }
    hash.digest().joinToString("") { "%02x".format(it) }
}

/** Resumable chat attachment uploads per conversation key, plus verified downloads. */
internal class ChatUploads(
    private val app: Application,
    private val scope: CoroutineScope,
    private val api: () -> Api,
    private val deviceId: () -> String,
    private val onError: (String) -> Unit,
) {
    var items by mutableStateOf<Map<String, List<ChatUpload>>>(emptyMap()); private set
    private val jobs = mutableMapOf<String, Job>()

    fun addFile(session: String, uri: android.net.Uri) {
        scope.launch { try { val (file, name, mime) = copyChatFile(app, uri); addCaptured(session, file, name, mime) } catch (e: Exception) { onError(e.message ?: "Cannot read file") } }
    }
    fun addCaptured(session: String, file: java.io.File, name: String, mime: String) {
        val current = items[session] ?: emptyList()
        if (current.size >= 10 || file.length() !in 1..CHAT_FILE_LIMIT || current.sumOf { it.file.length() } + file.length() > CHAT_TOTAL_LIMIT) { file.delete(); onError("Attachment limit exceeded"); return }
        val item = ChatUpload(UUID.randomUUID().toString(), file, name, mime)
        items = items + (session to (current + item)); retry(session, item)
    }
    fun retry(session: String, item: ChatUpload) {
        if (jobs[item.id]?.isActive == true) return
        val client = api()
        fun update(progress: Float, state: String, error: String? = null) { items = items + (session to (items[session] ?: emptyList()).map { if (it.id == item.id) it.copy(progress = progress, state = state, error = error) else it }) }
        jobs[item.id] = scope.launch {
            update(item.progress, "uploading")
            try {
                val base = attachmentBase(session)
                val digest = sha256Hex(item.file)
                val created = client.request(base, "POST", JSONObject().put("id", item.id).put("name", item.name).put("mime_type", item.mime).put("size_bytes", item.file.length()).put("sha256", digest))
                var offset = created.optLong("uploaded_bytes")
                while (offset < item.file.length()) {
                    val bytes = withContext(Dispatchers.IO) { java.io.RandomAccessFile(item.file, "r").use { input -> input.seek(offset); ByteArray(minOf(4 * 1024 * 1024L, item.file.length() - offset).toInt()).also { input.readFully(it) } } }
                    val next = client.request("$base/${item.id}/chunks", "POST", JSONObject().put("offset", offset).put("content_b64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)))
                    offset = next.getLong("uploaded_bytes"); update(offset.toFloat() / item.file.length(), "uploading")
                }
                client.request("$base/${item.id}/seal", "POST"); update(1f, "ready")
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { update(item.progress, "failed", e.message ?: "Upload failed") }
        }
    }
    fun remove(session: String, id: String) {
        jobs.remove(id)?.cancel()
        val item = items[session]?.find { it.id == id }
        items = items + (session to (items[session] ?: emptyList()).filter { it.id != id })
        scope.launch { runCatching { api().request("${attachmentBase(session)}/$id", "DELETE") }; item?.file?.delete() }
    }
    /** Forgets sent uploads; the caller owns deleting their local files. */
    fun drop(session: String, ids: Collection<String>) {
        items = items + (session to (items[session] ?: emptyList()).filter { it.id !in ids })
    }
    suspend fun info(session: String, id: String) = api().request("${attachmentBase(session)}/$id")
    suspend fun download(session: String, id: String): java.io.File {
        val dir = java.io.File(app.cacheDir, "chat-downloads").apply { mkdirs() }
        val file = java.io.File(dir, "${deviceId()}-$id")
        if (file.exists()) return file
        val info = info(session, id)
        api().download("${attachmentBase(session)}/$id/content", file)
        val actual = sha256Hex(file)
        if (actual != info.optString("sha256")) { file.delete(); error("Attachment checksum mismatch") }
        return file
    }
    /** Cancels uploads, deletes local copies and downloaded files. */
    fun clear() {
        jobs.values.forEach { it.cancel() }; jobs.clear()
        items.values.flatten().forEach { it.file.delete() }; items = emptyMap()
        java.io.File(app.cacheDir, "chat-downloads").deleteRecursively()
    }
}
