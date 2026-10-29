package io.uggs.orchestrator

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, message: String, val code: String? = null) : IOException(message)
/** [texts] localizes the messages this client raises itself; without it (tests, background pushes) they stay English. */
class Api(private val server: String, private val token: String? = null, private val texts: Texts? = null) {
    private fun text(@androidx.annotation.StringRes id: Int, fallback: String, vararg args: Any): String = texts?.string(id, *args) ?: fallback
    companion object {
        internal var client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(25, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build()
    }
    suspend fun request(path: String, method: String = "GET", body: JSONObject? = null): JSONObject =
        call(path, method, if (method in listOf("POST", "PATCH", "PUT")) (body ?: JSONObject()).toString() else null)
    /** POSTs [body] byte for byte: an outbox retry must repeat the frozen request exactly. */
    suspend fun post(path: String, body: String): JSONObject = call(path, "POST", body)
    private suspend fun call(path: String, method: String, body: String?): JSONObject = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url("$server/companion/v1$path").header("Accept", "application/json")
        token?.let { builder.header("Authorization", "Bearer $it") }
        builder.method(method, body?.toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            val json = runCatching { JSONObject(response.body?.string() ?: "{}") }.getOrElse { throw IOException(text(R.string.model_invalid_response, "Invalid server response")) }
            if (!response.isSuccessful) throw ApiException(response.code, json.optString("message", text(R.string.model_request_failed_code, "Request failed (${response.code})", response.code)), json.optString("code"))
            json.optJSONObject("data") ?: json
        }
    }
    suspend fun download(path: String, output: java.io.File): java.io.File = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("$server/companion/v1$path").header("Authorization", "Bearer $token").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw ApiException(response.code, text(R.string.attach_download_failed, "Attachment download failed (${response.code})", response.code))
            val temp = java.io.File(output.parentFile, output.name + ".part")
            try {
                response.body!!.byteStream().use { input -> temp.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024); var bytes = 0L
                    while(true) { val count = input.read(buffer); if(count < 0) break; bytes+=count; require(bytes <= CHAT_FILE_LIMIT) { text(R.string.attach_too_large, "Attachment exceeds size limit") }; out.write(buffer,0,count) }
                } }
                check(temp.renameTo(output)) { text(R.string.attach_cannot_save, "Cannot save attachment") }; output
            } catch(e:Exception) { temp.delete(); throw e }
        }
    }
    fun live(listener: WebSocketListener): WebSocket {
        val request = Request.Builder().url("$server/companion/v1/ws")
            .header("Authorization", "Bearer $token").build()
        return client.newWebSocket(request, listener)
    }
}
