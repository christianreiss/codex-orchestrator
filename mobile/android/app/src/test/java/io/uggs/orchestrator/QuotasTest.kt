package io.uggs.orchestrator
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
class QuotasTest {
    private val now = Instant.parse("2026-10-26T08:00:00Z").toEpochMilli()
    private fun account() = JSONObject("""{"fetched_at":"2026-10-26T07:59:00Z","stale":false,"windows":[{"kind":"weekly","used_percent":0,"resets_at":"2026-11-01T08:00:00Z"}]}""")
    @Test fun distinguishesZeroUsageFromUnavailableAndExpiredReadings() {
        assertEquals("Current", quotaDataStatus(account(), now))
        assertEquals("Unavailable", quotaDataStatus(JSONObject(), now))
        assertEquals("Stale", quotaDataStatus(account().put("stale", true), now))
        assertEquals("Stale", quotaDataStatus(account(), now + 700_000))
        val expired = account()
        expired.getJSONArray("windows").getJSONObject(0).put("resets_at", "2026-10-26T07:00:00Z")
        assertEquals("Stale", quotaDataStatus(expired, now))
        assertEquals("Stale", quotaDataStatus(account().put("fetched_at", "invalid"), now))
    }
    @Test fun preservesProviderWindowMeaning() {
        assertEquals("Monthly", quotaWindowLabel(TestTexts, JSONObject("""{"kind":"monthly"}""")))
        assertEquals("Weekly", quotaWindowLabel(TestTexts, JSONObject("""{"kind":"weekly"}""")))
        assertEquals("5 hours", quotaWindowLabel(TestTexts, JSONObject("""{"kind":"short","limit_seconds":18000}""")))
    }
}
