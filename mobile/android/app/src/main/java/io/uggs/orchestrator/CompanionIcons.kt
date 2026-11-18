package io.uggs.orchestrator

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.automirrored.rounded.InsertDriveFile
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.automirrored.rounded.Reply
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AttachFile
import androidx.compose.material.icons.rounded.BarChart
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DoneAll
import androidx.compose.material.icons.rounded.Dns
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material.icons.rounded.Tag
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

internal enum class CompanionSymbol {
    History, Quotas, Back, Forward, Up, Down, More, MoreVertical, Search, Chat, Group, Conference, Shield, Close, Check,
    Scan, Computer, Terminal, Attach, Camera, Send, Reply, Photo, Video, Audio, File,
    Add, Waiting, Read, Failed, Hosts, Tools, Notifications, SignOut, Refresh,
}

/** Material Symbols (rounded) for every glyph the app uses; one place maps meaning to artwork. */
internal fun CompanionSymbol.vector(): ImageVector = when (this) {
    CompanionSymbol.History -> Icons.Rounded.History
    CompanionSymbol.Quotas -> Icons.Rounded.BarChart
    CompanionSymbol.Back -> Icons.AutoMirrored.Rounded.ArrowBack
    CompanionSymbol.Forward -> Icons.AutoMirrored.Rounded.ArrowForward
    CompanionSymbol.Up -> Icons.Rounded.KeyboardArrowUp
    CompanionSymbol.Down -> Icons.Rounded.KeyboardArrowDown
    CompanionSymbol.More -> Icons.Rounded.MoreHoriz
    CompanionSymbol.MoreVertical -> Icons.Rounded.MoreVert
    CompanionSymbol.Search -> Icons.Rounded.Search
    CompanionSymbol.Chat -> Icons.AutoMirrored.Rounded.Chat
    CompanionSymbol.Group -> Icons.Rounded.Groups
    CompanionSymbol.Conference -> Icons.Rounded.Tag
    CompanionSymbol.Shield -> Icons.Rounded.VerifiedUser
    CompanionSymbol.Close -> Icons.Rounded.Close
    CompanionSymbol.Check -> Icons.Rounded.Check
    CompanionSymbol.Scan -> Icons.Rounded.QrCodeScanner
    CompanionSymbol.Computer, CompanionSymbol.Hosts -> Icons.Rounded.Dns
    CompanionSymbol.Terminal -> Icons.Rounded.Terminal
    CompanionSymbol.Attach -> Icons.Rounded.AttachFile
    CompanionSymbol.Camera -> Icons.Rounded.PhotoCamera
    CompanionSymbol.Send -> Icons.AutoMirrored.Rounded.Send
    CompanionSymbol.Reply -> Icons.AutoMirrored.Rounded.Reply
    CompanionSymbol.Photo -> Icons.Rounded.Image
    CompanionSymbol.Video -> Icons.Rounded.Videocam
    CompanionSymbol.Audio -> Icons.Rounded.Mic
    CompanionSymbol.File -> Icons.AutoMirrored.Rounded.InsertDriveFile
    CompanionSymbol.Add -> Icons.Rounded.Add
    CompanionSymbol.Waiting -> Icons.Rounded.Schedule
    CompanionSymbol.Read -> Icons.Rounded.DoneAll
    CompanionSymbol.Failed -> Icons.Rounded.ErrorOutline
    CompanionSymbol.Tools -> Icons.Rounded.Build
    CompanionSymbol.Notifications -> Icons.Rounded.Notifications
    CompanionSymbol.SignOut -> Icons.AutoMirrored.Rounded.Logout
    CompanionSymbol.Refresh -> Icons.Rounded.Refresh
}

@Composable internal fun CompanionIcon(symbol: CompanionSymbol, description: String? = null, tint: Color = LocalContentColor.current, modifier: Modifier = Modifier) {
    Icon(symbol.vector(), description, modifier.size(24.dp), tint)
}
