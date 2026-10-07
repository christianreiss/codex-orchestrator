package io.uggs.orchestrator

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import java.time.Instant

class MainActivity : ComponentActivity() {
    private val model: CompanionModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        setContent { CompanionTheme { CompanionScreen(model) } }
        model.notification(intent.getStringExtra("kind"), intent.getStringExtra("target_id"))
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); model.notification(intent.getStringExtra("kind"), intent.getStringExtra("target_id")) }
    override fun onStart() { super.onStart(); model.setForeground(true) }
    override fun onStop() { model.setForeground(false); super.onStop() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun CompanionScreen(model: CompanionModel) {
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    var more by remember { mutableStateOf(false) }
    var review by remember { mutableStateOf<JSONObject?>(null) }
    var clock by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { clock = System.currentTimeMillis(); kotlinx.coroutines.delay(1000) } }
    val fresh = model.fresh()
    val agents = model.overviewAgents()
    val requests = if (fresh) model.approvals.filter { liveApproval(it, clock) } else emptyList()
    val needsYou = if (fresh && model.can("agent_portal.manage")) agents.filter { isReachable(it) && needsReply(it) } else emptyList()
    val total = requests.size + needsYou.size
    val current = model.agents.firstOrNull { it.optString("id") == model.selected }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(model.notice) { model.notice?.let { snackbar.showSnackbar(it, duration = SnackbarDuration.Short); model.clearNotice() } }
    LaunchedEffect(model.connection?.deviceId) { if (model.connection != null && Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS) }
    LaunchedEffect(model.highlightApproval, requests) {
        model.highlightApproval?.let { id ->
            requests.firstOrNull { it.optString("id") == id }?.let { review = it; model.clearApprovalHighlight() }
            if (fresh && requests.none { it.optString("id") == id }) model.clearApprovalHighlight()
        }
    }
    BackHandler(model.selected != null && review == null && !more) { model.closeSession() }
    Scaffold(topBar = {
        Surface(color = MaterialTheme.colorScheme.background) {
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (model.selected != null) FilledTonalIconButton(onClick = model::closeSession, modifier = Modifier.size(48.dp)) { CompanionIcon(CompanionSymbol.Back, "Back") }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (model.selected != null) EngineIcon(current, Modifier.size(24.dp))
                        Text(if (model.selected != null) current?.let(::agentTitle) ?: "Agent" else if (model.connection != null) "Chats" else "Orchestrator",
                            modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis,
                            style = if (model.selected == null && model.connection != null) MaterialTheme.typography.headlineLarge else MaterialTheme.typography.titleLarge)
                    }
                    if (model.selected != null) HostBadge(current)
                    if (model.connection != null && (!fresh || model.selected == null)) {
                        val attentionStatus = if (!fresh) "Reconnecting…" else if (total == 1) "1 needs you" else if (total > 0) "$total need you" else if (model.unreadCount == 0) "All clear" else null
                        val unreadStatus = if (model.selected == null && model.unreadCount > 0) if (model.unreadCount == 1) "1 unread chat" else "${model.unreadCount} unread chats" else null
                        Text(listOfNotNull(unreadStatus, attentionStatus).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (model.connection != null) FilledTonalIconButton(onClick = { more = true }, modifier = Modifier.size(48.dp)) { CompanionIcon(CompanionSymbol.More, "More") }
            }
        }
    }, snackbarHost = { SnackbarHost(snackbar) }, bottomBar = {
        if (model.connection != null && model.selected == null && total > 0) {
            Surface(color = MaterialTheme.colorScheme.background) { Button(onClick = { if (requests.isNotEmpty()) review = requests.first() else model.openSession(needsYou.first().getString("id")) },
                modifier = Modifier.navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp).fillMaxWidth().heightIn(min = 52.dp), enabled = !model.busy) { Text("Review next · $total", style = MaterialTheme.typography.titleMedium) } }
        }
    }) { padding ->
        Column(Modifier.padding(padding).consumeWindowInsets(padding).fillMaxSize()) {
            if (model.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            model.error?.let { ErrorStrip(it, model::refreshNow, model::clearError) }
            when {
                model.connection == null -> PairScreen(model)
                model.selected != null -> ChatScreen(model, current, fresh)
                else -> NowScreen(model, agents, requests, fresh, onReview = { review = it })
            }
        }
    }
    review?.let { request -> ApprovalSheet(model, request, fresh, clock, onDismiss = { review = null }) }
    if (more) MoreSheet(model, onDismiss = { more = false })
}

@Composable private fun ErrorStrip(message: String, retry: () -> Unit, dismiss: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.errorContainer) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            Text(message, style = MaterialTheme.typography.bodyMedium)
            Row { TextButton(onClick = retry) { Text("Retry") }; TextButton(onClick = dismiss) { Text("Dismiss") } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun ApprovalSheet(model: CompanionModel, request: JSONObject, fresh: Boolean, now: Long, onDismiss: () -> Unit) {
    var minutes by remember(request.optLong("id")) { mutableIntStateOf(model.defaultMinutes.coerceIn(1, 480)) }
    val current = model.approvals.firstOrNull { it.optLong("id") == request.optLong("id") }
    val active = fresh && current?.let { liveApproval(it, now) } == true
    val remaining = current?.let { runCatching { (Instant.parse(it.optString("expires_at")).toEpochMilli() - now) / 1000 }.getOrDefault(0).coerceAtLeast(0) } ?: 0
    ModalBottomSheet(onDismissRequest = onDismiss, shape = RoundedCornerShape(topStart = 30.dp, topEnd = 30.dp), dragHandle = { BottomSheetDefaults.DragHandle() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Allow host access?", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(request.optString("fqdn"), style = MaterialTheme.typography.titleLarge)
            Text("Requesting IP: ${request.optString("request_ip")}", style = MaterialTheme.typography.bodyMedium)
            Text(if (!fresh) "Reconnect to review" else if (active) "Expires in ${remaining / 60}m ${remaining % 60}s" else "Already handled or expired", color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (active) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(15, 60, model.defaultMinutes.coerceIn(1, 480)).distinct().forEach { value ->
                        FilterChip(selected = minutes == value, onClick = { minutes = value }, enabled = !model.busy,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp), label = { Text(durationLabel(value)) })
                    }
                }
            }
            model.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { model.decide(request.optLong("id"), false, 0, onDismiss) }, enabled = active && !model.busy, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) { Text("Deny") }
                Button(onClick = { model.decide(request.optLong("id"), true, minutes, onDismiss) }, enabled = active && !model.busy, modifier = Modifier.weight(1.5f).heightIn(min = 52.dp)) { Text("Allow ${durationLabel(minutes)}") }
            }
            if (!active) TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("Close") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun MoreSheet(model: CompanionModel, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val pushStatus by PushStatus.state.collectAsState()
    var signOut by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss, shape = RoundedCornerShape(topStart = 30.dp, topEnd = 30.dp), dragHandle = { BottomSheetDefaults.DragHandle() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Connection", style = MaterialTheme.typography.titleLarge)
            Text(model.connection?.server?.removePrefix("https://") ?: "", style = MaterialTheme.typography.bodyMedium)
            Text(pushStatus, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = Alignment.CenterVertically) { Text("Alerts", Modifier.weight(1f)); Switch(checked = model.notifications, onCheckedChange = model::updateNotifications, enabled = !model.busy, modifier = Modifier.semantics { contentDescription = "Alerts" }) }
            model.selected?.let { id -> Row(verticalAlignment = Alignment.CenterVertically) { Text("Notify me of replies", Modifier.weight(1f)); Switch(checked = id in model.follows, onCheckedChange = { model.follow(id, it) }, enabled = !model.busy, modifier = Modifier.semantics { contentDescription = "Notify me of replies" }) } }
            OutlinedButton(onClick = { model.refreshNow(); onDismiss() }, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("Refresh") }
            TextButton(onClick = { context.startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)) }, modifier = Modifier.fillMaxWidth()) { Text("Android notification settings") }
            TextButton(onClick = { signOut = true }, modifier = Modifier.fillMaxWidth()) { Text("Sign out", color = MaterialTheme.colorScheme.error) }
        }
    }
    if (signOut) AlertDialog(onDismissRequest = { signOut = false }, title = { Text("Disconnect this phone?") }, text = { Text("You’ll need a new pairing code to reconnect.") },
        confirmButton = { TextButton(onClick = { model.logout(); onDismiss() }) { Text("Sign out") } }, dismissButton = { TextButton(onClick = { signOut = false }) { Text("Cancel") } })
}

@Composable private fun PairScreen(model: CompanionModel) {
    var pairing by remember { mutableStateOf<Pairing?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var pasteOpen by remember { mutableStateOf(false) }
    var pastedCode by remember { mutableStateOf("") }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let { raw -> try { pairing = Pairing.parse(raw); error = null } catch (_: Exception) { error = "This is not a valid Orchestrator pairing code." } }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp), verticalArrangement = Arrangement.Center) {
        Surface(shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.primaryContainer) {
            Box(Modifier.padding(24.dp)) { CompanionIcon(CompanionSymbol.Chat, tint = MaterialTheme.colorScheme.primary) }
        }
        Spacer(Modifier.height(24.dp))
        Text("Pair this phone", style = MaterialTheme.typography.headlineLarge)
        Spacer(Modifier.height(12.dp))
        Text("In the dashboard, open Account → Android devices → Pair Android device.")
        Spacer(Modifier.height(12.dp))
        Button(onClick = { scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the pairing code from your dashboard").setBeepEnabled(false).setOrientationLocked(false)) }, enabled = !model.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { CompanionIcon(CompanionSymbol.Scan); Spacer(Modifier.width(8.dp)); Text("Scan QR code") }
        TextButton(onClick = { pastedCode = ""; pasteOpen = true }, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text("Paste pairing code") }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
    if (pasteOpen) AlertDialog(onDismissRequest = { pasteOpen = false; pastedCode = "" },
        title = { Text("Pairing code") },
        text = { OutlinedTextField(value = pastedCode, onValueChange = { pastedCode = it.take(4096) }, label = { Text("Pairing JSON") }, maxLines = 5) },
        confirmButton = { TextButton(onClick = {
            try { pairing = Pairing.parse(pastedCode); error = null } catch (_: Exception) { error = "This is not a valid Orchestrator pairing code." }
            pasteOpen = false; pastedCode = ""
        }, enabled = pastedCode.isNotBlank()) { Text("Continue") } },
        dismissButton = { TextButton(onClick = { pasteOpen = false; pastedCode = "" }) { Text("Cancel") } })
    pairing?.let { code -> AlertDialog(onDismissRequest = { pairing = null }, title = { Text("Connect to this server?") },
        text = { Text(code.server) }, confirmButton = { TextButton(onClick = { pairing = null; model.pair(code) }) { Text("Connect") } }, dismissButton = { TextButton(onClick = { pairing = null }) { Text("Cancel") } }) }
}
