package io.uggs.orchestrator

import org.junit.Assert.*
import org.junit.Test

class UnreadStoreTest {
    @Test fun authoritativeCountsAreRepliesNotGlobalCursorDistance() {
        val state = ReplyUnreadLedger()
        state.observe(mapOf("a" to 900L, "b" to 1200L), counts = mapOf("a" to 2, "b" to 1))
        assertEquals(2, state.unreadReplyCount("a"))
        assertEquals(1, state.unreadReplyCount("b"))
        state.observe(mapOf("a" to 900L, "b" to 1200L), counts = mapOf("a" to 2, "b" to 1))
        state.push("a", 900, "snapshot-replay")
        state.push("a", 899, "older-reply")
        assertEquals(2, state.unreadReplyCount("a"))
        state.read("a", 900)
        assertEquals(0, state.unreadReplyCount("a"))
        assertEquals(mapOf("a" to 900L), state.readCursors())
        state.observe(mapOf("a" to 1400L, "b" to 1200L), counts = mapOf("a" to 1, "b" to 1))
        assertEquals(1, state.unreadReplyCount("a"))
    }
    @Test fun newPushIncrementsOnceAndStaleCountCannotEraseIt() {
        val state = ReplyUnreadLedger()
        state.observe(mapOf("a" to 10L), counts = mapOf("a" to 1))
        state.read("a", 10)
        state.push("a", 110, "first")
        state.push("a", 110, "replay")
        assertEquals(1, state.unreadReplyCount("a"))
        state.observe(mapOf("a" to 10L), pruneMissing = false, counts = mapOf("a" to 0))
        assertEquals(1, state.unreadReplyCount("a"))
        state.push("a", 200, "second")
        assertEquals(2, state.unreadReplyCount("a"))
        state.read("a", 110)
        assertEquals(setOf("a"), state.unreadIds())
        state.observe(mapOf("a" to 200L), counts = mapOf("a" to 1))
        assertEquals(1, state.unreadReplyCount("a"))
    }
    @Test fun legacyCountsMigrateAndAuthoritativeRetentionZeroClearsOnlyCount() {
        val legacy = org.json.JSONObject().put("sessions", org.json.JSONObject().put("a",
            org.json.JSONObject().put("read", 5).put("latest", 20)))
        val state = ReplyUnreadLedger(legacy)
        assertEquals(1, state.unreadReplyCount("a"))
        state.observe(mapOf("a" to 20L), counts = mapOf("a" to 3))
        val restored = ReplyUnreadLedger(state.json())
        assertEquals(3, restored.unreadReplyCount("a"))
        restored.observe(mapOf("a" to 0L), counts = mapOf("a" to 0))
        assertTrue(restored.unreadIds().isEmpty())
        restored.observe(mapOf("a" to 20L), pruneMissing = false, counts = mapOf("a" to 3))
        assertTrue(restored.unreadIds().isEmpty())
        assertEquals(mapOf("a" to 5L), restored.readCursors())
    }
    @Test fun stableSnapshotResolvesLegacyPushButStaleSnapshotCannotClearIt() {
        val state = ReplyUnreadLedger()
        state.observe(mapOf("a" to 10L)); state.read("a", 10)
        state.push("a", null, "legacy-late")
        state.observe(mapOf("a" to 10L), pruneMissing = false)
        state.read("a", 10)
        assertEquals(setOf("a"), state.unreadIds())
        state.observe(mapOf("a" to 10L), pruneMissing = true)
        assertTrue(state.unreadIds().isEmpty())
    }
    @Test fun staleSnapshotCannotErasePushThatArrivedDuringTheRequest() {
        val state = ReplyUnreadLedger()
        state.observe(mapOf("a" to 10L))
        state.push("b", 11, "new-session")
        state.observe(mapOf("a" to 10L), pruneMissing = false)
        assertEquals(setOf("a", "b"), state.unreadIds())
        state.observe(mapOf("a" to 10L), pruneMissing = true)
        assertEquals(setOf("a"), state.unreadIds())
    }
    @Test fun snapshotIsNotReadingAndReplayNeverAddsAnotherConversation() {
        val state = ReplyUnreadLedger()
        state.observe(mapOf("a" to 10L, "b" to 0L))
        assertEquals(setOf("a"), state.unreadIds())
        state.observe(mapOf("a" to 10L, "b" to 0L))
        state.push("a", 10, "push-10")
        assertEquals(setOf("a"), state.unreadIds())
        state.read("a", 10)
        assertTrue(state.unreadIds().isEmpty())
        assertFalse(state.push("a", 10, "delayed-push-10"))
        state.observe(mapOf("a" to 9L, "b" to 0L))
        assertTrue(state.unreadIds().isEmpty())
    }
    @Test fun readingAnOlderVisibleReplyDoesNotClearANewerReply() {
        val state = ReplyUnreadLedger()
        state.observe(mapOf("a" to 11L))
        state.read("a", 10)
        assertEquals(setOf("a"), state.unreadIds())
        state.read("a", 11)
        assertTrue(state.unreadIds().isEmpty())
        state.observe(mapOf("a" to 12L))
        assertEquals(setOf("a"), state.unreadIds())
    }
    @Test fun markersSurvivePersistenceAndAreRemovedOnlyAfterRetentionDisappearance() {
        val state = ReplyUnreadLedger()
        state.observe(mapOf("ended" to 20L, "read" to 10L))
        state.read("read", 10)
        val restored = ReplyUnreadLedger(state.json())
        assertEquals(setOf("ended"), restored.unreadIds())
        restored.observe(mapOf("ended" to 20L))
        assertEquals(setOf("ended"), restored.unreadIds())
        restored.observe(emptyMap())
        assertTrue(restored.unreadIds().isEmpty())
    }
    @Test fun legacyPushIsProvisionalAndReadingNeverAcknowledgesZeroCursor() {
        val state = ReplyUnreadLedger()
        state.push("a", null, "legacy")
        state.push("a", null, "legacy")
        state.observe(mapOf("a" to null))
        assertEquals(setOf("a"), state.unreadIds())
        state.read("a", 0)
        assertEquals(setOf("a"), state.unreadIds())
        state.read("a", 1)
        assertEquals(setOf("a"), state.unreadIds())
        state.observe(mapOf("a" to 1L))
        assertTrue(state.unreadIds().isEmpty())
    }
    @Test fun pairingIdentitySeparatesServersAndDevicesWithoutCredentials() {
        assertEquals(unreadScope("https://one.example/", "device"), unreadScope("https://one.example", "device"))
        assertNotEquals(unreadScope("https://one.example", "device"), unreadScope("https://two.example", "device"))
        assertNotEquals(unreadScope("https://one.example", "device"), unreadScope("https://one.example", "another"))
    }
}
