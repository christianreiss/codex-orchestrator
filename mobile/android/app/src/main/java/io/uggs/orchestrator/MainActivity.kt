package io.uggs.orchestrator

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
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
        installSplashScreen()
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        setContent { CompanionTheme { CompanionScreen(model) } }
        open(intent)
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); open(intent) }
    /** Notification extras and `orchestrator://chat/{key}` links both end up in the model's open handling. */
    private fun open(intent: Intent) {
        model.notification(intent.getStringExtra("kind"), intent.getStringExtra("target_id"))
        when (val link = Routes.parseDeepLink(intent.dataString)) {
            is ConversationKey.Direct -> model.notification("agent", link.agentId)
            is ConversationKey.Room -> model.openRoomLink(link.roomId)
            null -> Unit
        }
    }
    override fun onStart() { super.onStart(); model.setForeground(true) }
    override fun onStop() { model.setForeground(false); super.onStop() }
}

@Composable fun CompanionScreen(model: CompanionModel) {
    CompanionHomeTheme(enabled = model.connection != null) { key(model.connection?.deviceId) { CompanionContent(model) } }
}

/** Caps a chat column on wide windows so lines stay readable. */
@Composable private fun ChatWidth(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.fillMaxHeight().widthIn(max = CHAT_MAX_WIDTH_DP.dp).fillMaxWidth()) { content() }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun CompanionContent(model: CompanionModel) {
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val haptic = LocalHapticFeedback.current
    val t = rememberTexts()
    val navController = rememberNavController()
    val backEntry by navController.currentBackStackEntryAsState()
    val route = backEntry?.destination?.route
    val onChatRoute = Routes.isChat(route)
    val homeTab = if (onChatRoute || route == null) Routes.CHATS else route
    val wide = isWideWindow(LocalConfiguration.current.screenWidthDp)
    var more by remember { mutableStateOf(false) }
    var review by remember { mutableStateOf<JSONObject?>(null) }
    var clock by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { clock = System.currentTimeMillis(); kotlinx.coroutines.delay(1000) } }
    val fresh = model.fresh()
    val agents = model.overviewAgents()
    val activityClock = remember(clock, model.agents) { model.activityNow() }
    val requests = if (fresh) model.approvals.filter { liveApproval(it, clock) } else emptyList()
    val needsYou = if (fresh && model.can("agent_portal.manage")) agents.filter { needsReply(it) && (hasUrgentNotice(it) || isReachable(it)) } else emptyList()
    val total = requests.size + needsYou.size
    val current = model.agents.firstOrNull { it.optString("id") == model.selected }
    val shared = model.roomChats.current
    val inConversation = model.selected != null || model.roomChats.selected != null
    val chatKey: ConversationKey? = model.roomChats.selected?.let { ConversationKey.Room(it) } ?: model.selected?.let { ConversationKey.Direct(it) }
    val snackbar = remember { SnackbarHostState() }
    val overviewState = rememberSaveableStateHolder()
    fun goTab(target: String) {
        navController.navigate(target) {
            popUpTo(navController.graph.findStartDestination().id) { saveState = true }
            launchSingleTop = true; restoreState = true
        }
    }
    LaunchedEffect(model.notice) { model.notice?.let { snackbar.showSnackbar(it, duration = SnackbarDuration.Short); model.clearNotice() } }
    LaunchedEffect(model.connection?.deviceId) { if (model.connection != null && Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS) }
    LaunchedEffect(model.highlightApproval, requests) {
        model.highlightApproval?.let { id ->
            if (model.can("hosts.activate_insecure")) goTab(Routes.AUTHORIZATIONS)
            requests.firstOrNull { it.optString("id") == id }?.let { review = it; model.clearApprovalHighlight() }
            if (fresh && requests.none { it.optString("id") == id }) model.clearApprovalHighlight()
        }
    }
    // Room links wait for the room list; give up if the room never shows up.
    LaunchedEffect(model.pendingRoomLink, model.roomChats.rooms) {
        val id = model.pendingRoomLink ?: return@LaunchedEffect
        val room = model.roomChats.rooms.firstOrNull { it.optString("id") == id }
        if (room != null) { model.openRoom(room); model.clearRoomLink() } else { kotlinx.coroutines.delay(15_000); model.clearRoomLink() }
    }
    // The model owns which chat is open; the NavHost mirrors it so system back, predictive back and tabs keep a real history.
    var navigatedKey by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(chatKey) {
        val here = navController.currentDestination?.route
        if (chatKey != null) {
            if (!(Routes.isChat(here) && navigatedKey == chatKey.storageKey)) {
                navController.navigate(Routes.chat(chatKey)) {
                    if (Routes.isChat(here)) popUpTo(Routes.CHAT_PATTERN) { inclusive = true } else launchSingleTop = true
                }
            }
            navigatedKey = chatKey.storageKey
        } else {
            navigatedKey = null
            if (Routes.isChat(here)) navController.popBackStack()
        }
    }
    LaunchedEffect(route) {
        // Leaving the chat route through back or a tab closes the conversation in the model.
        if (route != null && !Routes.isChat(route) && (model.selected != null || model.roomChats.selected != null)) model.closeSession()
    }
    fun back() { if (onChatRoute) navController.popBackStack() else model.closeSession() }
    Scaffold(topBar = {
        TopAppBar(
            title = {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (model.selected != null) EngineIcon(current, Modifier.size(24.dp))
                        Text(if (model.roomChats.selected != null) shared?.optString("title") ?: stringResource(R.string.title_conversation) else if (model.selected != null) current?.let { agentTitle(t, it) } ?: stringResource(R.string.chat_agent_default) else stringResource(R.string.app_name),
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = if (!inConversation && model.connection != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onBackground,
                            style = MaterialTheme.typography.titleLarge)
                    }
                    if (model.selected != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        HostBadge(current)
                        current?.let { Text(activityDetail(t, it, activityClock), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                }
            },
            navigationIcon = { if (inConversation) IconButton(onClick = ::back, modifier = Modifier.size(48.dp)) { CompanionIcon(CompanionSymbol.Back, stringResource(R.string.cd_back)) } },
            actions = { if (model.connection != null) IconButton(onClick = { more = true }, modifier = Modifier.size(48.dp)) { CompanionIcon(CompanionSymbol.MoreVertical, stringResource(R.string.cd_more)) } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background, scrolledContainerColor = MaterialTheme.colorScheme.background),
        )
    }, bottomBar = {
        if (model.connection != null && (!inConversation || wide)) NavigationBar {
            NavigationBarItem(selected = homeTab == Routes.CHATS, onClick = { goTab(Routes.CHATS) }, icon = { CompanionIcon(CompanionSymbol.Chat) }, label = { Text(stringResource(R.string.nav_chats)) }, modifier = Modifier.testTag("tab-chats"))
            if (model.can("admin.read") && model.can("auth.read_metadata")) NavigationBarItem(selected = homeTab == Routes.QUOTAS, onClick = { goTab(Routes.QUOTAS) }, icon = { CompanionIcon(CompanionSymbol.Quotas) }, label = { Text(stringResource(R.string.nav_quotas)) }, modifier = Modifier.testTag("tab-quotas"))
            if (model.can("admin.read")) NavigationBarItem(selected = homeTab == Routes.HOSTS, onClick = { goTab(Routes.HOSTS) }, icon = { CompanionIcon(CompanionSymbol.Computer) }, label = { Text(stringResource(R.string.nav_hosts)) }, modifier = Modifier.testTag("tab-hosts"))
            if (model.can("hosts.activate_insecure")) NavigationBarItem(selected = homeTab == Routes.AUTHORIZATIONS, onClick = { goTab(Routes.AUTHORIZATIONS) },
                icon = { BadgedBox(badge = { if (requests.isNotEmpty()) Badge { Text(requests.size.toString()) } }) { CompanionIcon(CompanionSymbol.Shield) } },
                label = { Text(stringResource(R.string.nav_authorizations)) }, modifier = Modifier.testTag("tab-authorizations"))
        }
    }, snackbarHost = { SnackbarHost(snackbar) }, floatingActionButton = {
        if (model.connection != null && !inConversation && homeTab != Routes.AUTHORIZATIONS && total > 0) {
            Button(onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.ContextClick)
                if (requests.isNotEmpty()) { goTab(Routes.AUTHORIZATIONS); review = requests.first() } else model.openSession(needsYou.first().getString("id"))
            },
                modifier = Modifier.heightIn(min = 56.dp).testTag("review-next"), shape = RoundedCornerShape(18.dp), enabled = !model.busy,
                elevation = ButtonDefaults.buttonElevation(defaultElevation = 3.dp)) {
                CompanionIcon(CompanionSymbol.Shield)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.main_review_next, total), style = MaterialTheme.typography.labelLarge)
            }
        }
    }) { padding ->
        Column(Modifier.padding(padding).consumeWindowInsets(padding).fillMaxSize()) {
            if (model.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            // Connection state is only shown when it is not healthy; the details live in the More sheet.
            Column(Modifier.animateContentSize()) {
                if (model.connection != null && !fresh) ConnectionBanner(model.connecting, model.showingSavedChats)
            }
            model.error?.let { ErrorStrip(it, model::refreshNow, model::clearError) }
            if (model.connection == null) PairScreen(model)
            else NavHost(navController, startDestination = Routes.CHATS, modifier = Modifier.weight(1f).fillMaxWidth(),
                enterTransition = { fadeIn(tween(180)) }, exitTransition = { fadeOut(tween(120)) },
                popEnterTransition = { fadeIn(tween(180)) }, popExitTransition = { fadeOut(tween(120)) }) {
                composable(Routes.CHATS) { ChatsRoute(model, current, agents, fresh, activityClock, wide, onChat = false, overviewState = overviewState) }
                composable(Routes.CHAT_PATTERN, arguments = listOf(navArgument("key") { type = NavType.StringType })) {
                    ChatsRoute(model, current, agents, fresh, activityClock, wide, onChat = true, overviewState = overviewState)
                }
                composable(Routes.QUOTAS) {
                    if (model.can("admin.read") && model.can("auth.read_metadata")) QuotasScreen(model) else NowScreen(model, agents, fresh, activityClock)
                }
                composable(Routes.HOSTS) {
                    if (model.can("admin.read")) HostsScreen(model, fresh) else NowScreen(model, agents, fresh, activityClock)
                }
                composable(Routes.AUTHORIZATIONS) {
                    if (model.can("hosts.activate_insecure")) AuthorizationsScreen(model, fresh, clock, onReview = { review = it }) else NowScreen(model, agents, fresh, activityClock)
                }
            }
        }
    }
    review?.let { request -> ApprovalSheet(model, request, fresh, clock, onDismiss = { review = null }) }
    if (more) MoreSheet(model, onDismiss = { more = false })
}

/**
 * The Chats destination. Narrow windows show either the list or the open chat; wide windows keep the
 * list on the left and the open chat (or a hint) on the right.
 */
@Composable private fun ChatsRoute(model: CompanionModel, current: JSONObject?, agents: List<JSONObject>, fresh: Boolean, activityClock: Long, wide: Boolean, onChat: Boolean, overviewState: SaveableStateHolder) {
    @Composable fun list() = overviewState.SaveableStateProvider(model.connection?.deviceId ?: "") { NowScreen(model, agents, fresh, activityClock) }
    @Composable fun detail() {
        when {
            model.roomChats.selected != null -> ChatWidth { overviewState.SaveableStateProvider("room:${model.roomChats.selected}") { RoomScreen(model, fresh) } }
            model.selected != null -> ChatWidth { ChatScreen(model, current, fresh) }
        }
    }
    if (wide) {
        Row(Modifier.fillMaxSize()) {
            Box(Modifier.width(360.dp).fillMaxHeight()) { list() }
            VerticalDivider()
            Box(Modifier.weight(1f).fillMaxHeight()) {
                if (model.roomChats.selected == null && model.selected == null) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    EmptyState(stringResource(R.string.select_conversation), stringResource(R.string.select_conversation_detail))
                } else detail()
            }
        }
    } else if (onChat) detail() else list()
}

@Composable internal fun ServerConnectionStatus(connected: Boolean, connecting: Boolean, color: Color? = null) {
    val label = when {
        connected -> stringResource(R.string.server_connected)
        connecting -> stringResource(R.string.server_connecting)
        else -> stringResource(R.string.server_disconnected)
    }
    Text(label, modifier = Modifier.testTag("server-connection-status"),
        style = MaterialTheme.typography.bodySmall,
        color = color ?: if (connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Slim banner for a degraded server link: info while connecting, warning once disconnected. */
@Composable private fun ConnectionBanner(connecting: Boolean, savedChats: Boolean) {
    val container = if (connecting) MaterialTheme.status.infoContainer else MaterialTheme.status.warningContainer
    val content = if (connecting) MaterialTheme.status.onInfoContainer else MaterialTheme.status.onWarningContainer
    Surface(color = container, contentColor = content) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ServerConnectionStatus(false, connecting, color = content)
            if (savedChats) Text(stringResource(R.string.banner_saved_chats), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable private fun ErrorStrip(message: String, retry: () -> Unit, dismiss: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.errorContainer) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            Text(message, style = MaterialTheme.typography.bodyMedium)
            Row { TextButton(onClick = retry) { Text(stringResource(R.string.action_retry)) }; TextButton(onClick = dismiss) { Text(stringResource(R.string.action_dismiss)) } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun ApprovalSheet(model: CompanionModel, request: JSONObject, fresh: Boolean, now: Long, onDismiss: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    val t = rememberTexts()
    var minutes by remember(request.optLong("id")) { mutableIntStateOf(model.defaultMinutes.coerceIn(1, 480)) }
    val current = model.approvals.firstOrNull { it.optLong("id") == request.optLong("id") }
    val active = fresh && current?.let { liveApproval(it, now) } == true
    LaunchedEffect(request.optLong("id"), fresh, active) {
        if (fresh && !active) onDismiss()
    }
    val remaining = current?.let { runCatching { (Instant.parse(it.optString("expires_at")).toEpochMilli() - now) / 1000 }.getOrDefault(0).coerceAtLeast(0) } ?: 0
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.testTag("approval-sheet"), shape = SheetShape, dragHandle = { BottomSheetDefaults.DragHandle() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.approval_title), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(request.optString("fqdn"), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.auth_requesting_ip, request.optString("request_ip")), style = MaterialTheme.typography.bodyMedium)
            Text(if (!fresh) stringResource(R.string.approval_reconnect) else if (active) stringResource(R.string.auth_expires_in, stringResource(R.string.duration_m_s, remaining / 60, remaining % 60)) else stringResource(R.string.approval_handled), color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (active) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(15, 60, model.defaultMinutes.coerceIn(1, 480)).distinct().forEach { value ->
                        FilterChip(selected = minutes == value, onClick = { minutes = value }, enabled = !model.busy,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp), label = { Text(durationLabel(t, value)) })
                    }
                }
            }
            model.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { haptic.performHapticFeedback(HapticFeedbackType.Reject); model.decide(request.optLong("id"), false, 0, onDismiss) }, enabled = active && !model.busy, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) { Text(stringResource(R.string.approval_deny)) }
                Button(onClick = { haptic.performHapticFeedback(HapticFeedbackType.Confirm); model.decide(request.optLong("id"), true, minutes, onDismiss) }, enabled = active && !model.busy, modifier = Modifier.weight(1.5f).heightIn(min = 52.dp)) { Text(stringResource(R.string.approval_allow, durationLabel(t, minutes))) }
            }
            if (!active) TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.action_close)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun MoreSheet(model: CompanionModel, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val pushStatus by PushStatus.state.collectAsState()
    var signOut by remember { mutableStateOf(false) }
    val alertsLabel = stringResource(R.string.more_alerts)
    val notifyLabel = stringResource(R.string.more_notify_replies)
    ModalBottomSheet(onDismissRequest = onDismiss, shape = SheetShape, dragHandle = { BottomSheetDefaults.DragHandle() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.more_title), style = MaterialTheme.typography.titleLarge)
            // Re-evaluate freshness while this sheet is open, including a silent server timeout.
            var connectionClock by remember { mutableLongStateOf(0L) }
            LaunchedEffect(Unit) { while (true) { connectionClock++; kotlinx.coroutines.delay(1000) } }
            key(connectionClock) { ServerConnectionStatus(model.fresh(), model.connecting) }
            Text(model.connection?.server?.removePrefix("https://") ?: "", style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(pushStatus), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = Alignment.CenterVertically) { Text(alertsLabel, Modifier.weight(1f)); Switch(checked = model.notifications, onCheckedChange = model::updateNotifications, enabled = !model.busy, modifier = Modifier.semantics { contentDescription = alertsLabel }) }
            model.selected?.let { id -> Row(verticalAlignment = Alignment.CenterVertically) { Text(notifyLabel, Modifier.weight(1f)); Switch(checked = id in model.follows, onCheckedChange = { model.follow(id, it) }, enabled = !model.busy, modifier = Modifier.semantics { contentDescription = notifyLabel }) } }
            OutlinedButton(onClick = { model.refreshNow(); onDismiss() }, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(stringResource(R.string.action_refresh)) }
            TextButton(onClick = { context.startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)) }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.more_android_settings)) }
            TextButton(onClick = { signOut = true }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.action_sign_out), color = MaterialTheme.colorScheme.error) }
        }
    }
    if (signOut) AlertDialog(onDismissRequest = { signOut = false }, title = { Text(stringResource(R.string.sign_out_title)) }, text = { Text(stringResource(R.string.sign_out_body)) },
        confirmButton = { TextButton(onClick = { model.logout(); onDismiss() }) { Text(stringResource(R.string.action_sign_out)) } }, dismissButton = { TextButton(onClick = { signOut = false }) { Text(stringResource(R.string.action_cancel)) } })
}

@Composable private fun PairScreen(model: CompanionModel) {
    var pairing by remember { mutableStateOf<Pairing?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var pasteOpen by remember { mutableStateOf(false) }
    var pastedCode by remember { mutableStateOf("") }
    val invalidCode = stringResource(R.string.pair_invalid)
    val scanPrompt = stringResource(R.string.pair_scan_prompt)
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let { raw -> try { pairing = Pairing.parse(raw); error = null } catch (_: Exception) { error = invalidCode } }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp), verticalArrangement = Arrangement.Center) {
        Surface(shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.primaryContainer) {
            Box(Modifier.padding(24.dp)) { CompanionIcon(CompanionSymbol.Chat, tint = MaterialTheme.colorScheme.primary) }
        }
        Spacer(Modifier.height(24.dp))
        Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.headlineLarge)
        Spacer(Modifier.height(12.dp))
        Text(stringResource(R.string.pair_instructions))
        Spacer(Modifier.height(12.dp))
        Button(onClick = { scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt(scanPrompt).setBeepEnabled(false).setOrientationLocked(false)) }, enabled = !model.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { CompanionIcon(CompanionSymbol.Scan); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.pair_scan)) }
        TextButton(onClick = { pastedCode = ""; pasteOpen = true }, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.pair_paste)) }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
    if (pasteOpen) AlertDialog(onDismissRequest = { pasteOpen = false; pastedCode = "" },
        title = { Text(stringResource(R.string.pair_code_title)) },
        text = { OutlinedTextField(value = pastedCode, onValueChange = { pastedCode = it.take(4096) }, label = { Text(stringResource(R.string.pair_json)) }, maxLines = 5) },
        confirmButton = { TextButton(onClick = {
            try { pairing = Pairing.parse(pastedCode); error = null } catch (_: Exception) { error = invalidCode }
            pasteOpen = false; pastedCode = ""
        }, enabled = pastedCode.isNotBlank()) { Text(stringResource(R.string.action_continue)) } },
        dismissButton = { TextButton(onClick = { pasteOpen = false; pastedCode = "" }) { Text(stringResource(R.string.action_cancel)) } })
    pairing?.let { code -> AlertDialog(onDismissRequest = { pairing = null }, title = { Text(stringResource(R.string.pair_connect_title)) },
        text = { Text(code.server) }, confirmButton = { TextButton(onClick = { pairing = null; model.pair(code) }) { Text(stringResource(R.string.action_connect)) } }, dismissButton = { TextButton(onClick = { pairing = null }) { Text(stringResource(R.string.action_cancel)) } }) }
}
