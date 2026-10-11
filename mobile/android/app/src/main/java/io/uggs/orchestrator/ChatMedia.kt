package io.uggs.orchestrator

import android.Manifest
import android.content.Intent
import android.content.Context
import android.graphics.BitmapFactory
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.provider.OpenableColumns
import android.widget.MediaController
import android.widget.VideoView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.UUID

const val CHAT_FILE_LIMIT = 100L * 1024 * 1024
const val CHAT_TOTAL_LIMIT = 250L * 1024 * 1024

data class ChatUpload(val id: String, val file: File, val name: String, val mime: String, val progress: Float = 0f, val state: String = "uploading", val error: String? = null)

suspend fun copyChatFile(context: Context, uri: Uri): Triple<File, String, String> = withContext(Dispatchers.IO) {
    var name = "attachment"
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) name = c.getString(0) ?: name }
    val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
    val dir = File(context.cacheDir, "chat-uploads").apply { mkdirs() }
    val file = File(dir, UUID.randomUUID().toString())
    try {
        context.contentResolver.openInputStream(uri)?.use { input -> file.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024); var size = 0L
            while (true) { val read = input.read(buffer); if (read < 0) break; size += read; require(size <= CHAT_FILE_LIMIT) { "File exceeds 100 MiB limit" }; output.write(buffer, 0, read) }
        } } ?: error("Cannot read selected file")
        require(file.length() > 0) { "File is empty" }
        Triple(file, name, mime)
    } catch(e: Exception) { file.delete(); throw e }
}

@Composable internal fun ChatUploadControls(model: CompanionModel, session: String, enabled: Boolean) {
    val context = LocalContext.current
    var captureFile by remember { mutableStateOf<File?>(null) }
    var recording by remember { mutableStateOf(false) }
    var recorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var audioFile by remember { mutableStateOf<File?>(null) }
    val files = model.chatUploads[session] ?: emptyList()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> uris.forEach { model.addChatFile(session, it) } }
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) captureFile?.let { model.addCapturedFile(session, it, "photo.jpg", "image/jpeg") } else captureFile?.delete() }
    val videoContract = remember { object : ActivityResultContracts.CaptureVideo() {
        override fun createIntent(context: Context, input: Uri): Intent = super.createIntent(context, input).putExtra("android.intent.extra.durationLimit", 900)
    } }
    val video = rememberLauncherForActivityResult(videoContract) { ok -> if (ok) captureFile?.let { model.addCapturedFile(session, it, "video.mp4", "video/mp4") } else captureFile?.delete() }
    fun stopAudio() {
        try { recorder?.stop(); audioFile?.let { model.addCapturedFile(session, it, "audio.m4a", "audio/mp4") } }
        catch(e: Exception) { audioFile?.delete(); model.chatError(e.message ?: "Audio recording failed") }
        finally { recorder?.release(); recorder = null; recording = false }
    }
    fun recordAudio() {
        try {
            val file = File(context.cacheDir, "chat-audio-${UUID.randomUUID()}.m4a"); audioFile = file
            @Suppress("DEPRECATION") val next = MediaRecorder()
            next.setAudioSource(MediaRecorder.AudioSource.MIC); next.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            next.setAudioEncoder(MediaRecorder.AudioEncoder.AAC); next.setMaxDuration(900000); next.setOutputFile(file.absolutePath)
            next.setOnInfoListener { _, what, _ -> if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) stopAudio() }
            recorder = next; next.prepare(); next.start(); recording = true
        } catch(e: Exception) { recorder?.release(); recorder = null; recording = false; model.chatError(e.message ?: "Audio recording unavailable") }
    }
    val audioPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if(granted) recordAudio() else model.chatError("Microphone permission is required for recording") }
    fun capture(mime: String): Uri {
        val file = File(context.cacheDir, "chat-capture-${UUID.randomUUID()}.${if(mime == "image") "jpg" else "mp4"}")
        captureFile = file
        return FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    }
    var captureKind by remember { mutableStateOf("image") }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) runCatching { if(captureKind == "image") photo.launch(capture("image")) else video.launch(capture("video")) }.onFailure { model.chatError("Camera is unavailable") }
        else model.chatError("Camera permission is required for capture")
    }
    DisposableEffect(Unit) { onDispose { runCatching { recorder?.stop() }; recorder?.release() } }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { picker.launch(arrayOf("*/*")) }, enabled = enabled && !recording) { Text("Attach") }
            TextButton(onClick = { captureKind="image"; cameraPermission.launch(Manifest.permission.CAMERA) }, enabled = enabled && !recording) { Text("Photo") }
            TextButton(onClick = { captureKind="video"; cameraPermission.launch(Manifest.permission.CAMERA) }, enabled = enabled && !recording) { Text("Video") }
            TextButton(onClick = { if(recording) stopAudio() else audioPermission.launch(Manifest.permission.RECORD_AUDIO) }, enabled = enabled) { Text(if(recording) "Stop" else "Audio") }
        }
        files.forEach { item ->
            Row(Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) { Text(item.name, style = MaterialTheme.typography.labelMedium); Text(item.error ?: if(item.state == "uploading") "${(item.progress * 100).toInt()}% uploaded" else item.state, style = MaterialTheme.typography.bodySmall) }
                if(item.state == "failed") TextButton(onClick = { model.retryChatUpload(session, item) }, enabled = enabled) { Text("Retry") }
                TextButton(onClick = { model.removeChatUpload(session, item.id) }, enabled = enabled) { Text("Remove") }
            }
        }
    }
}

@Composable internal fun ChatAttachment(model: CompanionModel, session: String, id: String) {
    var info by remember(id) { mutableStateOf<JSONObject?>(null) }
    var file by remember(id) { mutableStateOf<File?>(null) }
    var failed by remember(id) { mutableStateOf<String?>(null) }
    var reload by remember(id) { mutableIntStateOf(0) }
    val context = LocalContext.current
    LaunchedEffect(id, reload) {
        try {
            info = model.chatAttachmentInfo(session,id)
            file = model.downloadChatAttachment(session,id)
            while(info?.optJSONObject("processing")?.optString("state") in listOf("queued","processing")) { kotlinx.coroutines.delay(5000); info = model.chatAttachmentInfo(session,id) }
        } catch(e: Exception) { failed = e.message ?: "Attachment unavailable" }
    }
    Column(Modifier.padding(8.dp)) {
        Text(info?.optString("name") ?: "Attachment", style = MaterialTheme.typography.labelMedium)
        if(failed != null) { Text(failed!!, style = MaterialTheme.typography.bodySmall); TextButton(onClick = { failed = null; reload++ }) { Text("Retry download") } }
        else if(file == null) LinearProgressIndicator(Modifier.fillMaxWidth())
        file?.let { local ->
            val mime = info?.optString("mime_type") ?: "application/octet-stream"
            if(mime.startsWith("image/")) {
                var bitmap by remember(local) { mutableStateOf<android.graphics.Bitmap?>(null) }
                LaunchedEffect(local) { bitmap = withContext(Dispatchers.IO) { val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeFile(local.absolutePath,bounds); var sample=1; while(bounds.outWidth/sample>1600 || bounds.outHeight/sample>1600) sample*=2; BitmapFactory.decodeFile(local.absolutePath,BitmapFactory.Options().apply { inSampleSize=sample }) } }
                bitmap?.let { Image(it.asImageBitmap(), info?.optString("name"), Modifier.fillMaxWidth().heightIn(max=240.dp)) }
            } else if(mime.startsWith("audio/")) AudioPlayback(local)
            else if(mime.startsWith("video/")) AndroidView(factory = { ctx -> VideoView(ctx).apply { setVideoPath(local.absolutePath); setMediaController(MediaController(ctx).also { it.setAnchorView(this) }) } }, modifier = Modifier.fillMaxWidth().height(220.dp))
            val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(mime)) { uri -> if(uri != null) model.saveChatAttachment(local,uri) }
            TextButton(onClick = { save.launch(info?.optString("name") ?: "attachment") }) { Text("Save file") }
            TextButton(onClick = {
                runCatching { val uri = FileProvider.getUriForFile(context,"${context.packageName}.files",local); context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri,mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) }.onFailure { model.chatError("No installed app can open this file") }
            }) { Text(if(mime.startsWith("image/")) "Open full image" else "Open file") }
        }
        info?.optJSONObject("processing")?.let { processing ->
            Text(if(processing.optString("state") == "ready") "Prepared for agent" else processing.optString("error", "Media: ${processing.optString("state")}"),style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable private fun AudioPlayback(file: File) {
    var playing by remember(file) { mutableStateOf(false) }
    var ready by remember(file) { mutableStateOf(false) }
    var failed by remember(file) { mutableStateOf(false) }
    val player = remember(file) { MediaPlayer() }
    DisposableEffect(player) {
        player.setOnPreparedListener { ready = true }
        player.setOnCompletionListener { playing = false }
        player.setOnErrorListener { _, _, _ -> failed = true; true }
        runCatching { player.setDataSource(file.absolutePath); player.prepareAsync() }.onFailure { failed = true }
        onDispose { player.release() }
    }
    TextButton(onClick = { runCatching { if(playing) player.pause() else player.start(); playing=!playing }.onFailure { failed=true } }, enabled=ready && !failed) { Text(if(failed) "Audio unavailable" else if(playing) "Pause audio" else "Play audio") }
}
