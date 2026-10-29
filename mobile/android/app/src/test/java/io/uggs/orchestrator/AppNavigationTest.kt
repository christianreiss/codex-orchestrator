package io.uggs.orchestrator

import org.junit.Assert.*
import org.junit.Test

class AppNavigationTest {
    @Test fun routeKeyRoundTripsDirectAndRoomKeys() {
        val direct = ConversationKey.Direct("3f1c2d4e-0000-4000-8000-123456789abc")
        val room = ConversationKey.Room("room/with space+plus:colon")
        assertEquals("chat/" + direct.agentId, Routes.chat(direct))
        for (key in listOf(direct, room)) {
            val segment = Routes.chat(key).removePrefix("chat/")
            assertFalse("no raw slash or colon in $segment", segment.contains('/') || segment.contains(':'))
            assertEquals(key, ConversationKey.fromStorageKey(Routes.decodeKey(segment)!!))
        }
    }

    @Test fun recognisesChatRoutesOnly() {
        assertTrue(Routes.isChat(Routes.CHAT_PATTERN))
        assertTrue(Routes.isChat("chat/abc"))
        assertFalse(Routes.isChat(Routes.CHATS))
        assertFalse(Routes.isChat(null))
    }

    @Test fun deepLinkParsesChatsAndRejectsEverythingElse() {
        val room = ConversationKey.Room("r 1")
        assertEquals(room, Routes.parseDeepLink(Routes.deepLink(room)))
        assertEquals(ConversationKey.Direct("abc"), Routes.parseDeepLink("orchestrator://chat/abc"))
        assertNull(Routes.parseDeepLink(null))
        assertNull(Routes.parseDeepLink("orchestrator://chat/"))
        assertNull(Routes.parseDeepLink("orchestrator://chat/a/b"))
        assertNull(Routes.parseDeepLink("orchestrator://chat/room:"))
        assertNull(Routes.parseDeepLink("https://chat/abc"))
        // Notification identities share the scheme but not the host.
        assertNull(Routes.parseDeepLink("orchestrator://notification/scope/agent/abc"))
    }

    @Test fun wideWindowStartsAt840dp() {
        assertFalse(isWideWindow(839)); assertTrue(isWideWindow(840))
    }

    @Test fun quotaLevelsFollowTheThresholds() {
        assertEquals(QuotaLevel.OK, quotaLevel(0.0))
        assertEquals(QuotaLevel.OK, quotaLevel(69.9))
        assertEquals(QuotaLevel.WARNING, quotaLevel(70.0))
        assertEquals(QuotaLevel.WARNING, quotaLevel(90.0))
        assertEquals(QuotaLevel.ERROR, quotaLevel(90.1))
        assertEquals(QuotaLevel.UNKNOWN, quotaLevel(Double.NaN))
    }
}
