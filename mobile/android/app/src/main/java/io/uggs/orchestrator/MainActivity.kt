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
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.text.font.FontWeight
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

@Composable fun CompanionTheme(content: @Composable () -> Unit) {
    val scheme = if (androidx.compose.foundation.isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFF7CDBC8), secondary = Color(0xFFB4CCC5))
        else lightColorScheme(primary = Color(0xFF176B60), secondary = Color(0xFF49665F), background = Color(0xFFF7FAF8), surface = Color(0xFFF7FAF8))
    MaterialTheme(colorScheme = scheme, content = content)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun CompanionScreen(model: CompanionModel) {
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    var more by remember { mutableStateOf(false) }
    var review by remember { mutableStateOf<JSONObject?>(null) }
    var clock by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { clock = System.currentTimeMillis(); kotlinx.coroutines.delay(1000) } }
    val fresh = model.fresh()
    val agents = if (fresh && model.can("agent_portal.manage") && model.can("agent_portal.reveal_transcript")) readyAgents(model.agents) else emptyList()
    val requests = if (fresh) model.approvals.filter { liveApproval(it, clock) } else emptyList()
    val needsYou = agents.filter(::needsReply)
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
        TopAppBar(title = { Column {
            Text(if (model.selected == null) "Now" else current?.let(::agentTitle) ?: "Agent", maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
            if (model.connection != null) Text(if (!fresh) "Reconnecting…" else if (model.selected != null) current?.let(::agentDetail) ?: "" else if (total == 1) "1 needs you" else if (total > 0) "$total need you" else "All clear", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } },
            navigationIcon = { if (model.selected != null) TextButton(onClick = model::closeSession, modifier = Modifier.heightIn(min = 48.dp)) { Text("Back") } },
            actions = { if (model.connection != null) TextButton(onClick = { more = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("More") } })
    }, snackbarHost = { SnackbarHost(snackbar) }, bottomBar = {
        if (model.connection != null && model.selected == null && total > 0) {
            Surface { Button(onClick = { if (requests.isNotEmpty()) review = requests.first() else model.openSession(needsYou.first().getString("id")) },
                modifier = Modifier.navigationBarsPadding().padding(16.dp).fillMaxWidth().heightIn(min = 64.dp), enabled = !model.busy) { Text("Review next · $total", style = MaterialTheme.typography.titleMedium) } }
        }
    }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
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

@Composable private fun NowScreen(model: CompanionModel, agents: List<JSONObject>, requests: List<JSONObject>, fresh: Boolean, onReview: (JSONObject) -> Unit) {
    val attention = agents.filter(::needsReply)
    val ready = agents.filterNot(::needsReply)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.Bottom)) {
        if (!fresh) item {
            Text("Checking what needs you…", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 24.dp))
            OutlinedButton(onClick = model::refreshNow, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text("Retry connection") }
        }
        if (requests.isNotEmpty() || attention.isNotEmpty()) item { SectionLabel("Needs you") }
        items(requests, key = { "approval:${it.optLong("id")}" }) { request ->
            Card(onClick = { onReview(request) }, modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(request.optString("fqdn"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text("Allow host access", color = MaterialTheme.colorScheme.onSecondaryContainer, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        items(attention, key = { it.getString("id") }) { AgentRow(it, true) { model.openSession(it.getString("id")) } }
        if (ready.isNotEmpty()) item { SectionLabel("Ready · ${ready.size}") }
        items(ready, key = { it.getString("id") }) { AgentRow(it, false) { model.openSession(it.getString("id")) } }
        if (fresh && agents.isEmpty() && requests.isEmpty()) item {
            Text("Nothing needs you", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Text("No agents ready to talk.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 24.dp))
        }
    }
}

@Composable private fun SectionLabel(text: String) { Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp, bottom = 2.dp)) }

@Composable private fun AgentRow(agent: JSONObject, attention: Boolean, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = if (attention) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(agentTitle(agent), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(agentDetail(agent), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (attention) Text(agent.optJSONObject("pending_prompt")?.optString("question") ?: agent.optJSONObject("attention")?.optString("summary")?.takeIf { it.isNotBlank() } ?: "Needs your reply", maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable private fun ChatScreen(model: CompanionModel, agent: JSONObject?, fresh: Boolean) {
    val prompt = agent?.optJSONObject("pending_prompt")
    val messages = conversationEvents(model.events)
    val list = rememberLazyListState()
    val writable = fresh && model.can("agent_portal.manage") && agent?.let(::isReachable) == true
    LaunchedEffect(messages.size, prompt?.optString("id")) {
        if (prompt != null) list.animateScrollToItem(messages.size)
        else if (messages.isNotEmpty()) list.animateScrollToItem(messages.lastIndex)
    }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(messages, key = { it.optLong("cursor") }) { event ->
                val own = event.optString("type") == "user_message"
                Row(Modifier.fillMaxWidth(), horizontalArrangement = if (own) Arrangement.End else Arrangement.Start) {
                    Surface(shape = RoundedCornerShape(18.dp), color = if (own) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.widthIn(max = 360.dp)) {
                        SelectionContainer { Text(event.getJSONObject("payload").optString("text"), Modifier.padding(16.dp)) }
                    }
                }
            }
            if (prompt != null) item(key = "question") {
                Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.secondaryContainer) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Your decision", style = MaterialTheme.typography.labelLarge)
                        Text(prompt.optString("question"), style = MaterialTheme.typography.titleMedium)
                        prompt.optJSONArray("options")?.strings()?.forEach { option ->
                            OutlinedButton(onClick = { model.draft = option; model.send(prompt) }, enabled = writable && !model.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text(option) }
                        }
                    }
                }
            }
            if (messages.isEmpty() && prompt == null) item { Text("What do you need?", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        if (!writable) Text(if (!fresh) "Reconnecting — draft kept" else "Agent is no longer reachable", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(shadowElevation = 4.dp) {
            Row(Modifier.fillMaxWidth().imePadding().padding(12.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = model.draft, onValueChange = { model.draft = it }, modifier = Modifier.weight(1f), maxLines = 4, enabled = !model.busy, placeholder = { Text(if (prompt != null) "Your answer" else "Message") })
                Button(onClick = { model.send(prompt) }, enabled = writable && !model.busy && model.draft.isNotBlank(), modifier = Modifier.heightIn(min = 60.dp)) { Text("Send") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun ApprovalSheet(model: CompanionModel, request: JSONObject, fresh: Boolean, now: Long, onDismiss: () -> Unit) {
    var minutes by remember(request.optLong("id")) { mutableIntStateOf(model.defaultMinutes.coerceIn(1, 480)) }
    val current = model.approvals.firstOrNull { it.optLong("id") == request.optLong("id") }
    val active = fresh && current?.let { liveApproval(it, now) } == true
    val remaining = current?.let { runCatching { (Instant.parse(it.optString("expires_at")).toEpochMilli() - now) / 1000 }.getOrDefault(0).coerceAtLeast(0) } ?: 0
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Allow host access?", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(request.optString("fqdn"), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Text("Requesting IP: ${request.optString("request_ip")}", style = MaterialTheme.typography.bodyMedium)
            Text(if (!fresh) "Reconnect to review" else if (active) "Expires in ${remaining / 60}m ${remaining % 60}s" else "Already handled or expired", color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (active) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(15, 60, model.defaultMinutes.coerceIn(1, 480)).distinct().forEach { value ->
                        FilterChip(selected = minutes == value, onClick = { minutes = value }, enabled = !model.busy,
                            modifier = Modifier.weight(1f).heightIn(min = 52.dp), label = { Text(durationLabel(value)) })
                    }
                }
            }
            model.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = { model.decide(request.optLong("id"), false, 0, onDismiss) }, enabled = active && !model.busy, modifier = Modifier.weight(1f).heightIn(min = 64.dp)) { Text("Deny") }
                Button(onClick = { model.decide(request.optLong("id"), true, minutes, onDismiss) }, enabled = active && !model.busy, modifier = Modifier.weight(1.5f).heightIn(min = 64.dp)) { Text("Allow ${durationLabel(minutes)}") }
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
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Bottom) {
        Text("Pair this phone", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(12.dp))
        Text("In the dashboard, open Account → Android devices → Pair Android device.")
        Spacer(Modifier.height(16.dp))
        Button(onClick = { scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the pairing code from your dashboard").setBeepEnabled(false).setOrientationLocked(false)) }, enabled = !model.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)) { Text("Scan QR code") }
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
