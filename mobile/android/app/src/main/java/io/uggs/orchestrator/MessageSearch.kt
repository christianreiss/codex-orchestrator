package io.uggs.orchestrator

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * State of the message search screen (`GET /companion/v1/search`, `search_protocol` 1). The query is
 * only ever sent to the server and held here; it is never logged or persisted. A newer search
 * supersedes an older one still in flight ([generation]).
 */
internal class MessageSearch(
    private val scope: CoroutineScope,
    private val api: () -> Api,
    private val texts: Texts,
) {
    var query by mutableStateOf(""); private set
    var searchScope by mutableStateOf(SearchScope.All); private set
    var hits by mutableStateOf<List<SearchHit>>(emptyList()); private set
    var nextCursor by mutableStateOf<String?>(null); private set
    var truncated by mutableStateOf(false); private set
    var loading by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    /** True once a search for the current query and scope has answered. */
    var answered by mutableStateOf(false); private set
    private var generation = 0

    /** A changed query or scope drops the previous results at once; the caller debounces [run]. */
    fun update(newQuery: String = query, newScope: SearchScope = searchScope) {
        if (newQuery == query && newScope == searchScope) return
        query = newQuery; searchScope = newScope
        generation++
        hits = emptyList(); nextCursor = null; truncated = false; answered = false; error = null; loading = false
    }

    /** Searches the newest messages for the current query (at least [SEARCH_MIN_CHARS] characters). */
    fun run() {
        val q = normalizedQuery(query) ?: return
        fetch(q, searchScope, null)
    }

    /** The next older page of the current search. */
    fun older() {
        val cursor = nextCursor ?: return
        val q = normalizedQuery(query) ?: return
        if (loading) return
        fetch(q, searchScope, cursor)
    }

    fun reset() { generation++; query = ""; searchScope = SearchScope.All; hits = emptyList(); nextCursor = null; truncated = false; answered = false; error = null; loading = false }

    private fun fetch(q: String, searchScope: SearchScope, cursor: String?) {
        val epoch = ++generation
        loading = true; error = null
        scope.launch {
            try {
                val page = parseSearchPage(api().request(searchPath(q, searchScope, cursor)))
                if (epoch != generation) return@launch
                hits = if (cursor == null) page.hits else mergeSearchHits(hits, page.hits)
                nextCursor = page.nextCursor; truncated = page.truncated; answered = true
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (epoch == generation) { error = searchError(texts, e); answered = cursor != null && hits.isNotEmpty() } }
            finally { if (epoch == generation) loading = false }
        }
    }
}
