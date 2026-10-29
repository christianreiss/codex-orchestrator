package io.uggs.orchestrator

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Pure rules of R5 reactions, pins and search (RoomAnnotations.kt). */
class RoomAnnotationsTest {
    private fun r(emoji: String, count: Int, mine: Boolean) = RoomReaction(emoji, count, mine)

    @Test fun togglingAReactionOnAddsOrJoinsAndOffRemovesOrLeaves() {
        assertEquals(listOf(r("👍", 1, true)), toggleReaction(emptyList(), "👍", true))
        assertEquals(listOf(r("👍", 3, true)), toggleReaction(listOf(r("👍", 2, false)), "👍", true))
        assertEquals(listOf(r("👍", 1, false)), toggleReaction(listOf(r("👍", 2, true)), "👍", false))
        assertEquals("the last own reaction removes the chip", emptyList<RoomReaction>(), toggleReaction(listOf(r("👍", 1, true)), "👍", false))
        assertEquals("already on stays", listOf(r("👍", 2, true)), toggleReaction(listOf(r("👍", 2, true)), "👍", true))
        assertEquals("off without own reaction stays", listOf(r("👍", 2, false)), toggleReaction(listOf(r("👍", 2, false)), "👍", false))
        val inverse = toggleReaction(toggleReaction(listOf(r("🎉", 1, false)), "🎉", true), "🎉", false)
        assertEquals("the inverse toggle restores the original", listOf(r("🎉", 1, false)), inverse)
    }

    @Test fun reactionsRoundTripThroughTheEventAndLegacyEventsHaveNone() {
        val event = JSONObject().put("id", "e1").put("content", "hi")
        assertNull("an adapted legacy event has no reactions field", roomReactions(event))
        val updated = withReactions(event, listOf(r("❤️", 2, true), r("🚀", 1, false)))
        assertNull("the original is not modified", roomReactions(event))
        assertEquals(listOf(r("❤️", 2, true), r("🚀", 1, false)), roomReactions(updated))
        assertEquals(emptyList<RoomReaction>(), roomReactions(JSONObject().put("reactions", JSONArray())))
        val odd = JSONObject().put("reactions", JSONArray().put(JSONObject().put("emoji", "👍").put("count", 0)).put(JSONObject().put("count", 2)).put(JSONObject().put("emoji", "👀").put("count", 2)))
        assertEquals("zero counts and missing emoji are dropped", listOf(r("👀", 2, false)), roomReactions(odd))
    }

    @Test fun pickerOffersTheWebConsolesEightEmoji() {
        assertEquals(listOf("👍", "❤️", "😄", "🎉", "👀", "✅", "❌", "🚀"), QUICK_REACTIONS)
    }

    @Test fun pinnedListsAreReadFromAnswersAndReplacedAsAWhole() {
        assertNull(roomPinned(JSONObject()))
        assertEquals(listOf("b", "a"), roomPinned(JSONObject().put("pinned", JSONArray(listOf("b", "", "a")))))
        assertEquals(emptyList<String>(), roomPinned(JSONObject().put("pinned", JSONArray())))
        assertEquals(listOf("c", "a", "b"), togglePinned(listOf("a", "b"), "c", true))
        assertEquals("a repeated pin moves to the front", listOf("b", "a"), togglePinned(listOf("a", "b"), "b", true))
        assertEquals(listOf("a"), togglePinned(listOf("a", "b"), "b", false))
    }

    @Test fun pinEntriesKeepRemovedEventsAsUnavailable() {
        val response = JSONObject("""{"room_id":"r","pins":[
            {"event_id":"e2","pinned_by":"admin:1","pinned_at":"2026-10-29T10:00:00Z","event":{"id":"e2","created_at":"2026-10-29T09:00:00Z","actor":"agent:x","name":"Ada","kind":"chat","snippet":"Ship it","attachments":[]}},
            {"event_id":"e1","pinned_by":"admin:1","pinned_at":"2026-10-28T10:00:00Z","event":null}]}""")
        val pins = parseRoomPins(response)
        assertEquals(listOf("e2", "e1"), pins.map { it.eventId })
        assertEquals("Ship it", pins[0].snippet)
        assertEquals("Ada", pins[0].author)
        assertNull(pins[1].snippet)
        assertEquals(emptyList<RoomPin>(), parseRoomPins(JSONObject()))
    }

    @Test fun failuresReadAsSpecificMessages() {
        assertEquals(TestTexts.string(R.string.reaction_limit), annotationError(TestTexts, ApiException(409, "x", "reaction_limit"), pin = false))
        assertEquals(TestTexts.string(R.string.pin_limit), annotationError(TestTexts, ApiException(409, "x", "room_pin_limit"), pin = true))
        assertEquals("Too many changes. Try again in 12 seconds.", annotationError(TestTexts, ApiException(429, "x", "rate_limited", 12), pin = false))
        assertEquals("Too many changes. Try again in 1 second.", annotationError(TestTexts, ApiException(429, "x", "rate_limited", 1), pin = true))
        assertEquals(TestTexts.string(R.string.annotation_rate_limited_soon), annotationError(TestTexts, ApiException(429, "x", "rate_limited"), pin = false))
        assertEquals(TestTexts.string(R.string.pin_failed), annotationError(TestTexts, java.io.IOException(), pin = true))
        assertEquals("server words", annotationError(TestTexts, ApiException(404, "server words", "room_event_not_found"), pin = false))
    }

    // ---- search ----

    @Test fun highlightsAreUtf16IndicesIntoTheSnippetClampedAndMerged() {
        val snippet = "…ship 🚀 it now"
        // "🚀" is two UTF-16 units: the match "it" starts at index 9.
        assertEquals(9, snippet.indexOf("it"))
        assertEquals(listOf(9..10), highlightRanges(snippet, listOf(9 to 2)))
        assertEquals("a span past the end is cut", listOf(12..snippet.length - 1), highlightRanges(snippet, listOf(12 to 99)))
        assertEquals("invalid spans are dropped", emptyList<IntRange>(), highlightRanges(snippet, listOf(-1 to 3, 5 to 0, 500 to 2)))
        assertEquals("overlapping and touching spans merge, order is normalized", listOf(1..6), highlightRanges("abcdefgh", listOf(4 to 3, 1 to 3)))
        val emoji = highlightRanges(snippet, listOf(snippet.indexOf("🚀") to 2)).single()
        assertEquals("a match covering an emoji keeps both units", "🚀", snippet.substring(emoji.first, emoji.last + 1))
    }

    @Test fun searchPagesParseRoomAndDirectHitsAndCursors() {
        val page = parseSearchPage(JSONObject("""{"results":[
          {"scope":"room","conversation_key":"room:r1","conversation_id":"r1","title":"Release","event_id":"e9","created_at":"2026-10-29T10:00:00Z","actor":"agent:a","author":"Ada","snippet":"the release is ready","highlights":[{"start":4,"length":7}]},
          {"scope":"direct","conversation_key":"agent:s1","conversation_id":"s1","title":"Build","event_id":"7","event_cursor":7,"created_at":"2026-10-29T09:00:00Z","actor":"operator","author":"You","snippet":"release?","highlights":[{"start":0,"length":7}]},
          {"scope":"room","conversation_key":"","conversation_id":"x"}],
          "next_cursor":"abc==","truncated":true,"scanned":2000,"scopes":["rooms","direct"]}"""))
        assertEquals(2, page.hits.size)
        assertTrue(page.hits[0].isRoom)
        assertEquals(listOf(4..10), page.hits[0].highlights)
        assertEquals("release", page.hits[0].snippet.substring(4, 11))
        assertNull(page.hits[0].eventCursor)
        assertFalse(page.hits[1].isRoom)
        assertEquals(7L, page.hits[1].eventCursor)
        assertEquals("abc==", page.nextCursor)
        assertTrue(page.truncated)
        val last = parseSearchPage(JSONObject("""{"results":[],"next_cursor":null,"truncated":false}"""))
        assertNull("a null cursor means nothing older remains", last.nextCursor)
        assertFalse(last.truncated)
    }

    @Test fun queriesAreNormalizedAndEncodedAndPagesMergeOlderHitsBehindNewerOnes() {
        assertNull(normalizedQuery(" a "))
        assertEquals("two words", normalizedQuery("  two \n  words "))
        assertEquals(SEARCH_MAX_CHARS, normalizedQuery("x".repeat(500))!!.length)
        assertEquals("/search?q=a%26b+c&scope=rooms&limit=20", searchPath("a&b c", SearchScope.Rooms, null))
        assertEquals("/search?q=hi&scope=all&limit=20&cursor=a%3D%3D%2F", searchPath("hi", SearchScope.All, "a==/"))
        fun hit(event: String) = SearchHit("room", "room:r", "r", "T", event, null, "", "", "", "s", emptyList())
        assertEquals(listOf("1", "2", "3"), mergeSearchHits(listOf(hit("1"), hit("2")), listOf(hit("2"), hit("3"))).map { it.eventId })
    }

    @Test fun searchRateLimitsTellWhenToRetry() {
        assertEquals("Too many searches. Try again in 30 seconds.", searchError(TestTexts, ApiException(429, "x", "rate_limited", 30)))
        assertEquals(TestTexts.string(R.string.search_rate_limited_soon), searchError(TestTexts, ApiException(429, "x", "rate_limited")))
        assertEquals(TestTexts.string(R.string.search_failed), searchError(TestTexts, java.io.IOException("socket")))
    }

    @Test fun protocolFlagsAreOffUnlessTheServerAdvertisesThem() {
        assertEquals(RoomProtocols(), RoomProtocols.from(JSONObject()))
        val on = RoomProtocols.from(JSONObject().put("reactions_protocol", 1).put("pins_protocol", 1).put("search_protocol", 1))
        assertTrue(on.reactions && on.pins && on.search)
        val partial = RoomProtocols.from(JSONObject().put("pins_protocol", 1))
        assertTrue(partial.pins); assertFalse(partial.reactions); assertFalse(partial.search)
    }
}
