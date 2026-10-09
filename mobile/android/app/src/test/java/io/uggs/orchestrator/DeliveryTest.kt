package io.uggs.orchestrator

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DeliveryTest {
    private fun event(type: String, id: String? = "one") = JSONObject().put("type", type)
        .put("payload", JSONObject().put("message_id", id ?: JSONObject.NULL))
    private val own = event("user_message")
    private val active = JSONObject().put("presence", "working").put("active_turn_id", "one")

    @Test fun acceptanceIsNotReadingAndUnrelatedRepliesDoNotFinishWork() {
        assertEquals("Queued", deliveryLabel(own, emptyMap(), active, true))
        val receipts = deliveryIndex(listOf(event("message_accepted"), event("assistant_message", "other")))
        assertEquals("Delivered to agent", deliveryLabel(own, receipts, active, true))
        assertNull(deliveryLabel(event("assistant_message"), receipts, active, true))
        assertNull(deliveryLabel(event("user_message", null), receipts, active, true))
    }
    @Test fun workingNeedsAnExplicitReceiptAndTheSameFreshTurn() {
        val receipts = deliveryIndex(listOf(event("message_processing"), event("message_read"), event("message_accepted")))
        assertEquals("AI is working…", deliveryLabel(own, receipts, active, true))
        assertEquals("Read by AI", deliveryLabel(own, receipts, active, false))
        active.put("active_turn_id", "other")
        assertEquals("Read by AI", deliveryLabel(own, receipts, active, true))
    }
    @Test fun repliesAndReadingAreDurableDespiteLateTransportEvents() {
        val receipts = deliveryIndex(listOf(event("assistant_message"), event("message_processing"), event("message_canceled")))
        assertEquals("Replied", deliveryLabel(own, receipts, active, false))
        assertEquals("Read by AI", deliveryLabel(own, deliveryIndex(listOf(event("message_read"))), null, false))
        assertEquals("Not delivered — the agent never picked this up", deliveryLabel(own, deliveryIndex(listOf(event("message_canceled"))), null, true))
    }
}
