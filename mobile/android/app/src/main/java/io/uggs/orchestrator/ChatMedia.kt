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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun ChatUploadControls(model: CompanionModel, session: String, enabled: Boolean, composer: @Composable (() -> Unit, () -> Unit) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    val context = LocalContext.current
    var captureFile by remember { mutableStateOf<File?>(null) }
    var recording by remember { mutableStateOf(false) }
    var recorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var audioFile by remember { mutableStateOf<File?>(null) }
    val files = model.chatUploads[session] ?: emptyList()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> uris.forEach { model.addChatFile(session, it) } }
    val gallery = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> uris.forEach { model.addChatFile(session, it) } }
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
    if (menu) ModalBottomSheet(onDismissRequest = { menu = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Text("Add to message", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 12.dp))
            AttachmentOption("Photos", CompanionSymbol.Photo, enabled) { menu = false; gallery.launch(arrayOf("image/*")) }
            AttachmentOption("Camera", CompanionSymbol.Camera, enabled) { menu = false; captureKind = "image"; cameraPermission.launch(Manifest.permission.CAMERA) }
            AttachmentOption("Video", CompanionSymbol.Video, enabled) { menu = false; captureKind = "video"; cameraPermission.launch(Manifest.permission.CAMERA) }
            AttachmentOption("Audio", CompanionSymbol.Audio, enabled) { menu = false; audioPermission.launch(Manifest.permission.RECORD_AUDIO) }
            AttachmentOption("Document", CompanionSymbol.File, enabled) { menu = false; picker.launch(arrayOf("*/*")) }
        }
    }
    if (files.isNotEmpty()) LazyRow(Modifier.fillMaxWidth().testTag("attachment-previews"), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(files, key = { it.id }) { item ->
            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.width(136.dp)) {
                Column {
                    Box {
                        if (item.mime.startsWith("image/")) LocalChatImage(item.file, item.name, Modifier.fillMaxWidth().height(88.dp), crop = true)
                        else Box(Modifier.fillMaxWidth().height(56.dp), contentAlignment = Alignment.Center) { CompanionIcon(CompanionSymbol.File) }
                        FilledTonalIconButton(onClick = { model.removeChatUpload(session, item.id) }, enabled = enabled, modifier = Modifier.align(Alignment.TopEnd).size(48.dp)) {
                            CompanionIcon(CompanionSymbol.Close, "Remove ${item.name}")
                        }
                    }
                    Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
                        Text(item.name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        when (item.state) {
                            "uploading" -> {
                                LinearProgressIndicator(progress = { item.progress }, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp))
                                Text("${(item.progress * 100).toInt()}% uploaded", style = MaterialTheme.typography.labelSmall)
                            }
                            "failed" -> {
                                Text(item.error ?: "Upload failed", style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                TextButton(onClick = { model.retryChatUpload(session, item) }, enabled = enabled) { Text("Retry") }
                            }
                            else -> Text("Ready to send", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
        }
    }
    if (recording) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        CompanionIcon(CompanionSymbol.Audio, tint = MaterialTheme.colorScheme.error)
        Text("Recording audio…", Modifier.weight(1f).padding(horizontal = 12.dp))
        TextButton(onClick = { stopAudio() }) { Text("Stop") }
    }
    composer({ if (enabled && !recording) { focus.clearFocus(); menu = true } }, { if (enabled && !recording) { captureKind = "image"; cameraPermission.launch(Manifest.permission.CAMERA) } })
}

@Composable private fun AttachmentOption(label: String, symbol: CompanionSymbol, enabled: Boolean, action: () -> Unit) {
    Surface(onClick = action, enabled = enabled, shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surface) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            CompanionIcon(symbol, tint = MaterialTheme.colorScheme.primary)
            Text(label, style = MaterialTheme.typography.bodyLarge)
        }
    }
}

@Composable private fun LocalChatImage(file: File, name: String, modifier: Modifier, crop: Boolean = false) {
    var bitmap by remember(file) { mutableStateOf<android.graphics.Bitmap?>(null) }
    LaunchedEffect(file) {
        bitmap = withContext(Dispatchers.IO) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            var sample = 1
            while (bounds.outWidth / sample > 1600 || bounds.outHeight / sample > 1600) sample *= 2
            BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
        }
    }
    bitmap?.let { Image(it.asImageBitmap(), name, modifier, contentScale = if (crop) ContentScale.Crop else ContentScale.Fit) }
        ?: Box(modifier, contentAlignment = Alignment.Center) { CompanionIcon(CompanionSymbol.Photo, "Image preview unavailable") }
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
    Column(Modifier.fillMaxWidth()) {
        if (failed != null) {
            Text(failed!!, Modifier.padding(8.dp), style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { failed = null; reload++ }) { Text("Retry download") }
        } else if (file == null) {
            Box(Modifier.fillMaxWidth().height(140.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp)) }
        }
        file?.let { local ->
            val mime = info?.optString("mime_type") ?: "application/octet-stream"
            val name = info?.optString("name") ?: "Attachment"
            fun open() {
                runCatching {
                    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", local)
                    context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                }.onFailure { model.chatError("No installed app can open this file") }
            }
            var actions by remember(id) { mutableStateOf(false) }
            val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(mime)) { uri -> if (uri != null) model.saveChatAttachment(local, uri) }
            if (mime.startsWith("image/")) {
                Box {
                    LocalChatImage(local, name, Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(10.dp)).clickable(onClickLabel = "Open full image") { open() }, crop = true)
                    IconButton(onClick = { actions = true }, modifier = Modifier.align(Alignment.TopEnd).size(48.dp)) {
                        Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface.copy(alpha = .9f)) {
                            CompanionIcon(CompanionSymbol.MoreVertical, "Photo options", modifier = Modifier.padding(4.dp))
                        }
                    }
                    DropdownMenu(expanded = actions, onDismissRequest = { actions = false }) {
                        DropdownMenuItem(text = { Text("Save file") }, onClick = { actions = false; save.launch(name) })
                        DropdownMenuItem(text = { Text("Open full image") }, onClick = { actions = false; open() })
                    }
                }
            } else {
                Row(Modifier.fillMaxWidth().padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    CompanionIcon(if (mime.startsWith("audio/")) CompanionSymbol.Audio else if (mime.startsWith("video/")) CompanionSymbol.Video else CompanionSymbol.File)
                    Text(name, Modifier.weight(1f).padding(horizontal = 8.dp), style = MaterialTheme.typography.labelMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Box {
                        IconButton(onClick = { actions = true }) { CompanionIcon(CompanionSymbol.MoreVertical, "Attachment options") }
                        DropdownMenu(expanded = actions, onDismissRequest = { actions = false }) {
                            DropdownMenuItem(text = { Text("Save file") }, onClick = { actions = false; save.launch(name) })
                            DropdownMenuItem(text = { Text("Open file") }, onClick = { actions = false; open() })
                        }
                    }
                }
                if (mime.startsWith("audio/")) AudioPlayback(local)
                else if (mime.startsWith("video/")) AndroidView(factory = { ctx -> VideoView(ctx).apply { setVideoPath(local.absolutePath); setMediaController(MediaController(ctx).also { it.setAnchorView(this) }) } }, modifier = Modifier.fillMaxWidth().height(220.dp))
            }
        }
        info?.optJSONObject("processing")?.takeIf { it.optString("state") == "failed" }?.let { processing ->
            Text(processing.optString("error", "Media preparation failed; original available"), Modifier.padding(8.dp), style = MaterialTheme.typography.bodySmall)
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
