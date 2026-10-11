package io.uggs.orchestrator

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.ByteArrayOutputStream

/** One paired account, encrypted with Android Keystore and excluded from backups. */
internal class ChatCacheStore(context: Context) {
    private val vault = ConnectionStore(context)
    private val file = AtomicFile(File(context.noBackupFilesDir, "active-chat-cache.bin"))

    fun read(): String? = runCatching {
        file.openRead().use { input ->
            val bytes = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                require(bytes.size() + count <= ChatHistoryCache.MAX_BYTES + 28)
                bytes.write(buffer, 0, count)
            }
            String(vault.decryptCache(bytes.toByteArray()), Charsets.UTF_8)
        }
    }.getOrElse { file.delete(); null }

    fun write(value: String?) {
        if (value == null) { file.delete(); return }
        val bytes = value.toByteArray(Charsets.UTF_8)
        require(bytes.size <= ChatHistoryCache.MAX_BYTES)
        val encrypted = vault.encryptCache(bytes)
        val output = file.startWrite()
        try { output.write(encrypted); file.finishWrite(output) }
        catch (error: Exception) { file.failWrite(output); throw error }
    }
}
