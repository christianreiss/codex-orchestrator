package io.uggs.orchestrator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class Pairing(val server: String, val token: String) {
    companion object {
        fun parse(raw: String): Pairing {
            require(raw.length < 4096) { "Pairing code is too large" }
            val json = JSONObject(raw)
            require(json.getInt("version") == 1) { "Unsupported pairing code" }
            val url = json.getString("server").toHttpUrl()
            require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.encodedPath == "/" && url.query == null && url.fragment == null) { "An HTTPS server address is required" }
            val token = json.getString("token")
            require(token.matches(Regex("[a-f0-9]{64}"))) { "Invalid pairing code" }
            return Pairing(url.toString().trimEnd('/'), token)
        }
    }
}

data class Connection(val server: String, val token: String, val deviceId: String, val firebase: JSONObject?)

/** No credential or transcript is written outside Keystore-protected app storage. */
class ConnectionStore(context: Context) {
    private val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("companion", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("companion", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun save(connection: Connection) {
        val json = JSONObject().put("server", connection.server).put("token", connection.token).put("device_id", connection.deviceId).put("firebase", connection.firebase)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.doFinal(json.toString().toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString("value", Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)).commit())
    }
    @Synchronized fun load(): Connection? {
        val encoded = prefs.getString("value", null) ?: return null
        return try {
            val bytes = Base64.decode(encoded, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
            val json = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
            Connection(json.getString("server"), json.getString("token"), json.getString("device_id"), json.optJSONObject("firebase"))
        } catch (_: Exception) { clear(); null }
    }
    fun clear() { prefs.edit().clear().commit() }
}
