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
        assertEquals("Queued", deliveryLabel(TestTexts, own, emptyMap(), active, true))
        // A working agent whose receiver holds messages: the label says what the message waits for.
        val holding = JSONObject(active.toString()).put("receiver", JSONObject().put("failure", JSONObject.NULL)
            .put("sources", org.json.JSONArray().put(JSONObject().put("source", "portal"))))
        assertEquals("Waiting for the agent", deliveryLabel(TestTexts, own, emptyMap(), holding, true))
        val withdrawn = JSONObject().put("type", "message_canceled").put("payload", JSONObject().put("message_id", "one").put("canceled_by", "operator"))
        assertEquals("Message withdrawn", deliveryLabel(TestTexts, own, deliveryIndex(listOf(withdrawn)), holding, true))
        val receipts = deliveryIndex(listOf(event("message_accepted"), event("assistant_message", "other")))
        assertEquals("Delivered to agent", deliveryLabel(TestTexts, own, receipts, active, true))
        assertNull(deliveryLabel(TestTexts, event("assistant_message"), receipts, active, true))
        assertNull(deliveryLabel(TestTexts, event("user_message", null), receipts, active, true))
    }
    @Test fun workingNeedsAnExplicitReceiptAndTheSameFreshTurn() {
        val receipts = deliveryIndex(listOf(event("message_processing"), event("message_read"), event("message_accepted")))
        assertEquals("Working on it…", deliveryLabel(TestTexts, own, receipts, active, true))
        assertEquals("Read", deliveryLabel(TestTexts, own, receipts, active, false))
        active.put("active_turn_id", "other")
        assertEquals("Read", deliveryLabel(TestTexts, own, receipts, active, true))
    }
    @Test fun repliesAndReadingAreDurableDespiteLateTransportEvents() {
        val receipts = deliveryIndex(listOf(event("assistant_message"), event("message_processing"), event("message_canceled")))
        assertEquals("Replied", deliveryLabel(TestTexts, own, receipts, active, false))
        assertEquals("Read", deliveryLabel(TestTexts, own, deliveryIndex(listOf(event("message_read"))), null, false))
        assertEquals("Not delivered — the agent never picked this up", deliveryLabel(TestTexts, own, deliveryIndex(listOf(event("message_canceled"))), null, true))
    }
}
