import QtQuick
import QtTest
import "../org.codex.orchestrator/contents/ui" as Widget

TestCase {
    name: "RoomHistory"
    property var reads
    property var seen
    Component {
        id: history
        Widget.RoomHistory {}
    }
    function init() { reads = []; seen = [] }
    function openHistory() {
        return createTemporaryObject(history, this, {
            request: (method, path, body, receive) => {
                if (path === "/companion/v1/rooms/read") reads.push(receive)
                if (path === "/companion/v1/rooms/seen") seen.push(body)
            }
        })
    }
    function deliver(index, time) {
        reads[index](true, { events: [{ content: time, created_at: time }] })
    }
    function test_late_same_room_read_cannot_replace_events_or_mark_them_seen() {
        const room = openHistory()
        room.loadRoom("A")
        room.loadRoom("A")
        deliver(1, "new")
        deliver(0, "earlier")
        compare(room.events[0].content, "new")
        compare(seen, [{ room_id: "A", through: "new" }])
    }
    function test_returning_to_room_rejects_both_previous_selections() {
        const room = openHistory()
        room.loadRoom("A")
        room.loadRoom("B")
        room.loadRoom("A")
        deliver(0, "old A")
        deliver(1, "old B")
        compare(room.events, [])
        compare(seen, [])
        deliver(2, "current A")
        compare(room.events[0].content, "current A")
        compare(seen, [{ room_id: "A", through: "current A" }])
    }
    function test_slow_reads_can_still_advance_while_a_newer_read_is_in_flight() {
        const room = openHistory()
        room.loadRoom("A")
        room.loadRoom("A")
        deliver(0, "first")
        compare(room.events[0].content, "first")
        room.clear()
        room.loadRoom("A")
        deliver(1, "before logout")
        compare(room.events, [])
        compare(seen, [{ room_id: "A", through: "first" }])
    }
}
