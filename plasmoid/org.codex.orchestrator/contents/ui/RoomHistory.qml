import QtQml

QtObject {
    required property var request
    property string roomId: ""
    property var events: []
    property int nextRead: 0
    property int lastApplied: 0

    function clear() {
        lastApplied = ++nextRead
        roomId = ""
        events = []
    }

    function loadRoom(id) {
        if (roomId !== id) {
            lastApplied = ++nextRead
            events = []
            roomId = id
        }
        const order = ++nextRead
        request("POST", "/companion/v1/rooms/read", { room_id: id, limit: 40 }, (ok, d) => {
            if (!ok || !d || order <= lastApplied) return
            lastApplied = order
            const ev = (d.events || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at))
            events = ev
            if (ev.length) request("POST", "/companion/v1/rooms/seen",
                { room_id: id, through: ev[ev.length - 1].created_at }, () => {})
        })
    }
}
