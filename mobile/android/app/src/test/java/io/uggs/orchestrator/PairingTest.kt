package io.uggs.orchestrator

import org.junit.Assert.*
import org.junit.Test

class PairingTest {
    private val token = "a".repeat(64)
    private fun code(server: String) = """{"version":1,"server":"$server","token":"$token"}"""
    @Test fun acceptsHttpsOrigin() { assertEquals(Pairing("https://fleet.example:8443", token), Pairing.parse(code("https://fleet.example:8443"))) }
    @Test fun rejectsUnsafeAddresses() {
        listOf("http://fleet.example", "https://user:pass@fleet.example", "https://fleet.example/path", "https://fleet.example#token", "https://fleet.example?x=1").forEach { url ->
            assertTrue(url, runCatching { Pairing.parse(code(url)) }.isFailure)
        }
    }
    @Test fun rejectsMalformedOrFutureCodes() {
        listOf("not json", code("https://fleet.example").replace("\"version\":1", "\"version\":2"), code("https://fleet.example").replace(token, "x")).forEach {
            assertTrue(runCatching { Pairing.parse(it) }.isFailure)
        }
    }
}
