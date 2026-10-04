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
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

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
    val context = LocalContext.current
    val pushStatus by PushStatus.state.collectAsState()
    LaunchedEffect(model.connection?.deviceId) { if (model.connection != null && Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS) }
    BackHandler(model.selected != null) { model.closeSession() }
    Scaffold(topBar = {
        TopAppBar(title = { Column { Text(if (model.selected != null) "Conversation" else "Orchestrator", fontWeight = FontWeight.SemiBold)
            if (model.connection != null) Text(model.status, style = MaterialTheme.typography.labelSmall) } },
            navigationIcon = { if (model.selected != null) TextButton(onClick = { model.closeSession() }) { Text("Back") } },
            actions = { if (model.connection != null) TextButton(onClick = model::refreshNow) { Text("Refresh") } })
    }, bottomBar = {
        if (model.connection != null && model.selected == null) NavigationBar {
            listOf("Agents", "Approvals", "Settings").forEachIndexed { index, tab ->
                NavigationBarItem(selected = model.tab == tab, onClick = { model.tab = tab; model.refreshNow() },
                    icon = { Text(listOf("◉", "✓", "⚙")[index]) }, label = { Text(if (tab == "Approvals" && model.approvals.isNotEmpty()) "$tab (${model.approvals.size})" else tab) })
            }
        }
    }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            model.error?.let { error ->
                Surface(color = MaterialTheme.colorScheme.errorContainer) { Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(error, Modifier.weight(1f), color = MaterialTheme.colorScheme.onErrorContainer)
                    TextButton(onClick = model::clearError) { Text("Dismiss") }
                } }
            }
            if (model.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            when {
                model.connection == null -> PairScreen(model)
                model.selected != null -> ChatScreen(model)
                model.tab == "Agents" -> AgentsScreen(model)
                model.tab == "Approvals" -> ApprovalsScreen(model)
                else -> LazyColumn(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    item { Text("Your connection", style = MaterialTheme.typography.headlineSmall); Text(model.connection!!.server, style = MaterialTheme.typography.bodyMedium) }
                    item { Row(verticalAlignment = Alignment.CenterVertically) { Text("Push notifications", Modifier.weight(1f)); Switch(checked = model.notifications, onCheckedChange = model::updateNotifications, enabled = !model.busy) } }
                    item { Text(if (model.connection!!.firebase == null) "Firebase is not configured on this server. Chat and approvals are available while the app is open." else "Host requests, agent questions, and replies in followed conversations can notify you.") }
                    item { Text(pushStatus, style = MaterialTheme.typography.bodySmall) }
                    item { OutlinedButton(onClick = { context.startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)) }) { Text("Android notification settings") } }
                    item { Text("Following ${model.follows.size} conversations. Open a conversation to change its notification setting.", style = MaterialTheme.typography.bodyMedium) }
                    item { Button(onClick = model::logout, enabled = !model.busy) { Text("Sign out and revoke this device") } }
                }
            }
        }
    }
}

@Composable private fun PairScreen(model: CompanionModel) {
    var pairing by remember { mutableStateOf<Pairing?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var pasteOpen by remember { mutableStateOf(false) }
    var pastedCode by remember { mutableStateOf("") }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let { raw -> try { pairing = Pairing.parse(raw); error = null } catch (_: Exception) { error = "This is not a valid Orchestrator pairing code." } }
    }
    Column(Modifier.fillMaxSize().padding(28.dp), verticalArrangement = Arrangement.Center) {
        Text("Your agents.\nWithin reach.", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(20.dp))
        Text("Chat with your fleet and review host access requests from your phone.", style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(28.dp))
        Text("In the dashboard, open Account → Android devices → Pair Android device.")
        Spacer(Modifier.height(16.dp))
        Button(onClick = { scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the pairing code from your dashboard").setBeepEnabled(false).setOrientationLocked(false)) }, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text("Scan QR code") }
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

@Composable private fun AgentsScreen(model: CompanionModel) {
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 12.dp)) {
        item { Text("Fleet conversations", style = MaterialTheme.typography.headlineSmall); Text("Choose an agent to continue its conversation.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (model.agents.isEmpty()) item { EmptyCard("No agent sessions", "Sessions appear when the agent portal is enabled and a supported CLI session is running.") }
        items(model.agents, key = { it.getString("id") }) { agent ->
            Card(Modifier.fillMaxWidth().clickable(enabled = model.can("agent_portal.reveal_transcript")) { model.openSession(agent.getString("id")) }) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(agent.optString("fqdn", agent.optString("host", "Agent")), style = MaterialTheme.typography.titleMedium)
                    Text("${agent.optString("engine").replaceFirstChar { it.uppercase() }} · ${agent.optString("presence", "offline")}", color = MaterialTheme.colorScheme.primary)
                    Text(agent.optString("cwd"), style = MaterialTheme.typography.bodySmall, maxLines = 2)
                    agent.optJSONObject("pending_prompt")?.let { Text(it.optString("question"), maxLines = 2, fontWeight = FontWeight.Medium) }
                    if (!model.can("agent_portal.reveal_transcript")) Text("Your account cannot read transcripts.")
                }
            }
        }
    }
}

@Composable private fun ChatScreen(model: CompanionModel) {
    val id = model.selected ?: return
    val agent = model.agents.firstOrNull { it.optString("id") == id }
    val prompt = agent?.optJSONObject("pending_prompt")
    val list = rememberLazyListState()
    LaunchedEffect(model.events.size) { if (model.events.isNotEmpty()) list.animateScrollToItem(model.events.lastIndex) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(agent?.optString("engine") ?: "Agent", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            FilterChip(selected = id in model.follows, onClick = { model.follow(id, id !in model.follows) }, label = { Text(if (id in model.follows) "Following" else "Follow replies") })
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(model.events, key = { it.optLong("cursor") }) { event ->
                val own = event.optString("type") == "user_message"
                val payload = event.optJSONObject("payload") ?: JSONObject()
                val text = payload.optString("text").ifEmpty { payload.optString("question").ifEmpty { payload.optString("summary").ifEmpty { event.optString("type").replace('_', ' ') } } }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = if (own) Arrangement.End else Arrangement.Start) {
                    Column(Modifier.widthIn(max = 330.dp).background(if (own) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(16.dp)).padding(14.dp)) {
                        Text(if (own) "You" else if (event.optString("type") == "assistant_message") "Agent" else "Session", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        SelectionContainer { Text(text) }
                    }
                }
            }
        }
        if (prompt != null) Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
            Column(Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(prompt.optString("question"), fontWeight = FontWeight.Medium)
                prompt.optJSONArray("options")?.strings()?.forEach { option -> OutlinedButton(onClick = { model.draft = option }, enabled = !model.busy) { Text(option) } }
            }
        }
        val writable = model.can("agent_portal.manage") && agent?.optBoolean("relay_ready") == true
        if (!writable) Text("This session is not accepting messages right now.", Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall)
        Row(Modifier.fillMaxWidth().imePadding().padding(12.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(value = model.draft, onValueChange = { model.draft = it }, modifier = Modifier.weight(1f), maxLines = 5, enabled = writable && !model.busy,
                placeholder = { Text(if (prompt != null) "Your answer" else "Message the agent") })
            Button(onClick = { model.send(prompt) }, enabled = writable && !model.busy && model.draft.isNotBlank()) { Text(if (prompt != null) "Answer" else "Send") }
        }
    }
}

@Composable private fun ApprovalsScreen(model: CompanionModel) {
    var review by remember { mutableStateOf<JSONObject?>(null) }
    var minutes by remember { mutableStateOf(model.defaultMinutes.toString()) }
    LaunchedEffect(model.highlightApproval, model.approvals) {
        model.highlightApproval?.let { id -> if (review == null) { review = model.approvals.firstOrNull { it.optString("id") == id }; if (review != null) model.clearApprovalHighlight() } }
    }
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text("Host access", style = MaterialTheme.typography.headlineSmall); Text("Review who is waiting before granting access.") }
        if (!model.can("hosts.activate_insecure")) item { EmptyCard("Approval permission required", "Your dashboard role does not allow host access approvals.") }
        else if (model.approvals.isEmpty()) item { EmptyCard("Nothing waiting", "There are no live host requests. Requests that expired or were resolved elsewhere disappear automatically.") }
        items(model.approvals, key = { it.optLong("id") }) { request -> Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(request.optString("fqdn"), style = MaterialTheme.typography.titleMedium)
                Text("From ${request.optString("request_ip")}")
                Text("Expires ${formatTime(request.optString("expires_at"))}", style = MaterialTheme.typography.bodySmall)
                Button(onClick = { minutes = model.defaultMinutes.toString(); review = request; model.refreshNow() }) { Text("Review request") }
            }
        } }
    }
    review?.let { request ->
        val current = model.approvals.firstOrNull { it.optLong("id") == request.optLong("id") }
        var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
        LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); kotlinx.coroutines.delay(1000) } }
        val active = current != null && runCatching { Instant.parse(current.optString("expires_at")).toEpochMilli() > now }.getOrDefault(false)
        AlertDialog(onDismissRequest = { review = null }, title = { Text(request.optString("fqdn")) }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Requesting IP: ${request.optString("request_ip")}")
                Text(if (active) "Expires ${formatTime(request.optString("expires_at"))}" else "This request has expired or was already resolved.")
                OutlinedTextField(value = minutes, onValueChange = { minutes = it.filter(Char::isDigit).take(3) }, label = { Text("Access duration (0–480 minutes)") }, enabled = active, singleLine = true)
            }
        }, confirmButton = { Button(enabled = active && !model.busy && minutes.toIntOrNull() in 0..480, onClick = { model.decide(request.optLong("id"), true, minutes.toInt()); review = null }) { Text("Approve") } },
            dismissButton = { Row { TextButton(onClick = { review = null }) { Text("Close") }; TextButton(enabled = active && !model.busy, onClick = { model.decide(request.optLong("id"), false, 0); review = null }) { Text("Deny") } } })
    }
}
@Composable private fun EmptyCard(title: String, body: String) { Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { Text(title, style = MaterialTheme.typography.titleMedium); Text(body) } } }
private fun formatTime(value: String): String = runCatching { DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault()).format(Instant.parse(value)) }.getOrDefault(value)
