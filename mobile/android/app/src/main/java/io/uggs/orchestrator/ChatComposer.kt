package io.uggs.orchestrator

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp

/**
 * The one composer of direct chats and rooms. Direct chats send with an icon
 * button ("Send"); rooms keep a labelled button because its label carries the
 * retry state ("Retry send") of an unconfirmed message.
 */
@Composable internal fun ChatComposer(
    draft: String,
    onDraft: (String) -> Unit,
    placeholder: String,
    canSend: Boolean,
    sending: Boolean,
    fieldEnabled: Boolean = !sending,
    readOnly: Boolean = false,
    fieldTag: String? = null,
    sendTag: String? = null,
    sendLabel: String? = null,
    mediaActions: @Composable RowScope.() -> Unit = {},
    onSend: () -> Unit,
) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Surface(modifier = Modifier.weight(1f), shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerLow,
            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
            Row(verticalAlignment = Alignment.Bottom) {
                BasicTextField(
                    value = draft, onValueChange = onDraft, enabled = fieldEnabled, readOnly = readOnly, maxLines = 6,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp).padding(start = 16.dp, end = 4.dp, top = 12.dp, bottom = 12.dp)
                        .semantics { contentDescription = placeholder }.then(if (fieldTag != null) Modifier.testTag(fieldTag) else Modifier),
                    decorationBox = { field ->
                        Box { if (draft.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant); field() }
                    },
                )
                mediaActions()
            }
        }
        if (sendLabel != null) Button(onClick = onSend, enabled = canSend, modifier = Modifier.heightIn(min = 48.dp).then(if (sendTag != null) Modifier.testTag(sendTag) else Modifier)) {
            Text(sendLabel)
        } else FilledIconButton(
            onClick = onSend, enabled = canSend, modifier = Modifier.size(48.dp).semantics { contentDescription = "Send" }.then(if (sendTag != null) Modifier.testTag(sendTag) else Modifier),
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary),
        ) {
            if (sending) CircularProgressIndicator(Modifier.size(20.dp).semantics { contentDescription = "Sending" }, strokeWidth = 2.dp)
            else CompanionIcon(CompanionSymbol.Send)
        }
    }
}
