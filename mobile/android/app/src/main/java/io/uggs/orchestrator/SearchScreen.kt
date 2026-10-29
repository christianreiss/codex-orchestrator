package io.uggs.orchestrator

import android.text.format.DateFormat
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId

/** Quiet period after the last keystroke before a search request goes out. */
private const val SEARCH_DEBOUNCE_MS = 350L

/** The snippet with its matches set apart by weight and background, never by color alone. */
@Composable private fun HighlightedSnippet(hit: SearchHit) {
    val scheme = MaterialTheme.colorScheme
    val text = remember(hit.snippet, hit.highlights, scheme) {
        buildAnnotatedString {
            append(hit.snippet)
            hit.highlights.forEach { range ->
                addStyle(SpanStyle(fontWeight = FontWeight.Bold, background = scheme.tertiaryContainer, color = scheme.onTertiaryContainer), range.first, range.last + 1)
            }
        }
    }
    Text(text, maxLines = 4, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
}

@Composable internal fun SearchScreen(model: CompanionModel, fresh: Boolean) {
    val search = model.search
    val t = rememberTexts()
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val use24 = DateFormat.is24HourFormat(LocalContext.current)
    val normalized = normalizedQuery(search.query)
    LaunchedEffect(Unit) { if (search.query.isBlank()) runCatching { focus.requestFocus() } }
    // Debounced: every keystroke or scope change restarts the wait, and a finished search is not repeated on return.
    LaunchedEffect(search.query, search.searchScope, fresh) {
        if (normalized != null && fresh && !search.answered) { delay(SEARCH_DEBOUNCE_MS); search.run() }
    }
    val scopes = buildList {
        add(SearchScope.All to stringResource(R.string.search_scope_all))
        add(SearchScope.Rooms to stringResource(R.string.search_scope_rooms))
        if (model.can("agent_portal.reveal_transcript")) add(SearchScope.Direct to stringResource(R.string.search_scope_direct))
    }
    val hint = stringResource(R.string.search_hint)
    val unknown = stringResource(R.string.search_unknown_author)
    Column(Modifier.fillMaxSize().testTag("search-screen")) {
        OutlinedTextField(
            value = search.query, onValueChange = { search.update(newQuery = it.take(SEARCH_MAX_CHARS)) }, singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).focusRequester(focus).testTag("search-field").semantics { contentDescription = hint },
            placeholder = { Text(hint) },
            leadingIcon = { CompanionIcon(CompanionSymbol.Search, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
            trailingIcon = if (search.query.isNotEmpty()) { {
                IconButton(onClick = { search.update(newQuery = "") }, modifier = Modifier.size(48.dp)) { CompanionIcon(CompanionSymbol.Close, stringResource(R.string.chat_clear_search)) }
            } } else null,
            shape = MaterialTheme.shapes.medium, colors = searchFieldColors(),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { keyboard?.hide(); if (normalized != null && !search.loading) search.run() }),
        )
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            scopes.forEach { (scope, label) ->
                FilterChip(selected = search.searchScope == scope, onClick = { search.update(newScope = scope) }, label = { Text(label) }, modifier = Modifier.testTag("search-scope:${scope.wire}"))
            }
        }
        if (search.loading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
        LazyColumn(Modifier.fillMaxSize().testTag("search-results"), contentPadding = PaddingValues(top = 8.dp, bottom = 96.dp)) {
            if (search.query.isNotBlank() && normalized == null) item(key = "min") { SearchNote(stringResource(R.string.search_min_chars)) }
            search.error?.let { message ->
                item(key = "error") {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("search-error"))
                        if (normalized != null) TextButton(onClick = { if (search.nextCursor != null && search.hits.isNotEmpty()) search.older() else search.run() }, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.action_retry)) }
                    }
                }
            }
            items(search.hits, key = { it.id }) { hit ->
                val time = remember(hit.createdAt) { runCatching { Instant.parse(hit.createdAt) }.getOrNull() }
                val whenText = time?.let { dayLabel(t, it.atZone(ZoneId.systemDefault()).toLocalDate()) + " " + timeLabel(t, it, use24) }.orEmpty()
                val author = hit.author.ifBlank { unknown }
                val description = stringResource(R.string.search_result_cd, hit.title, author, whenText, hit.snippet)
                Column(
                    Modifier.fillMaxWidth().heightIn(min = 64.dp).testTag("search-hit:${hit.eventId}")
                        .clickable(role = Role.Button) { model.openSearchHit(hit) }
                        .semantics(mergeDescendants = true) { contentDescription = description }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(hit.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(listOf(author, whenText).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    HighlightedSnippet(hit)
                }
                HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f))
            }
            if (search.answered && search.hits.isEmpty() && search.nextCursor == null && search.error == null) item(key = "none") { SearchNote(stringResource(R.string.search_no_results)) }
            if (search.truncated && search.nextCursor != null) item(key = "truncated") { SearchNote(stringResource(R.string.search_truncated), Modifier.testTag("search-truncated")) }
            if (search.nextCursor != null) item(key = "older") {
                Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                    OutlinedButton(onClick = search::older, enabled = !search.loading && fresh, modifier = Modifier.heightIn(min = 48.dp).testTag("search-older")) { Text(stringResource(R.string.search_older)) }
                }
            }
        }
    }
}

@Composable private fun SearchNote(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
