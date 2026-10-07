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
class Api(private val server: String, private val token: String? = null) {
    companion object {
        internal var client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(25, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build()
    }
    suspend fun request(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url("$server/companion/v1$path").header("Accept", "application/json")
        token?.let { builder.header("Authorization", "Bearer $it") }
        builder.method(method, if (method in listOf("POST", "PATCH", "PUT")) (body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()) else null)
        client.newCall(builder.build()).execute().use { response ->
            val json = runCatching { JSONObject(response.body?.string() ?: "{}") }.getOrElse { throw IOException("Invalid server response") }
            if (!response.isSuccessful) throw ApiException(response.code, json.optString("message", "Request failed (${response.code})"), json.optString("code"))
            json.optJSONObject("data") ?: json
        }
    }
    fun live(listener: WebSocketListener): WebSocket {
        val request = Request.Builder().url("$server/companion/v1/ws")
            .header("Authorization", "Bearer $token").build()
        return client.newWebSocket(request, listener)
    }
}
