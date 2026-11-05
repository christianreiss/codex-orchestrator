import QtQuick
import QtQuick.Layouts
import org.kde.plasma.plasmoid
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.plasma5support as P5Support
import org.kde.kirigami as Kirigami
import org.kde.notification

PlasmoidItem {
    id: root

    readonly property string secretService: "codex-orchestrator-plasmoid"
    property string token: ""
    property bool secretLoaded: false
    property bool online: false
    property string error: ""
    property var requests: []
    property var windows: []
    property var fleet: ({ open: false, enabled_until: null })
    property var engines: []
    property var rooms: []
    property var events: []
    property string roomId: ""
    property int seenMaxId: 0
    property bool firstPoll: true
    readonly property bool paired: token !== "" && Plasmoid.configuration.serverUrl !== ""
    readonly property int pending: requests.length

    preferredRepresentation: compactRepresentation
    toolTipMainText: i18n("Codex Orchestrator")
    toolTipSubText: !paired ? i18n("Not paired")
        : !online ? (error || i18n("Offline"))
        : i18n("%1 pending, %2 open windows", pending, windows.length)

    // ── secret storage (libsecret → KWallet) ────────────────────────────────
    P5Support.DataSource {
        id: shell
        engine: "executable"
        connectedSources: []
        property var handlers: ({})
        onNewData: (source, data) => {
            disconnectSource(source)
            const h = handlers[source]
            delete handlers[source]
            if (h) h(data["exit code"], (data["stdout"] || "").trim())
        }
        function run(cmd, cb) {
            const s = cmd + " #" + Date.now() + Math.random()
            handlers[s] = cb
            connectSource(s)
        }
    }

    function loadToken() {
        shell.run("secret-tool lookup service " + secretService, (code, out) => {
            token = code === 0 ? out : ""
            secretLoaded = true
            if (paired) poll()
        })
    }
    function saveToken(t, cb) {
        if (!/^[A-Za-z0-9_.\-]+$/.test(t)) { cb(false); return }
        shell.run("printf %s '" + t + "' | secret-tool store --label='Codex Orchestrator plasmoid' service " + secretService,
            (code) => { if (code === 0) token = t; cb(code === 0) })
    }
    function unpair() {
        const base = Plasmoid.configuration.serverUrl
        const t = token
        if (t && base) request("DELETE", "/companion/v1/device", null, () => {})
        shell.run("secret-tool clear service " + secretService, () => {})
        token = ""; online = false; requests = []; windows = []; rooms = []; events = []
    }

    // ── HTTP ────────────────────────────────────────────────────────────────
    function request(method, path, body, cb) {
        const xhr = new XMLHttpRequest()
        xhr.open(method, Plasmoid.configuration.serverUrl.replace(/\/+$/, "") + path)
        if (token) xhr.setRequestHeader("Authorization", "Bearer " + token)
        if (body !== null && body !== undefined) xhr.setRequestHeader("Content-Type", "application/json")
        xhr.timeout = 15000
        xhr.onreadystatechange = () => {
            if (xhr.readyState !== XMLHttpRequest.DONE) return
            let json = null
            try { json = JSON.parse(xhr.responseText) } catch (e) {}
            const ok = xhr.status >= 200 && xhr.status < 300
            if (xhr.status === 401 && token) { error = i18n("Device revoked; pair again"); unpair() }
            cb(ok, json && json.data !== undefined ? json.data : json,
               ok ? "" : (json && json.message) || ("HTTP " + xhr.status), xhr.status)
        }
        xhr.ontimeout = () => cb(false, null, i18n("Timeout"), 0)
        xhr.onerror = () => cb(false, null, i18n("Network error"), 0)
        xhr.send(body === null || body === undefined ? undefined : JSON.stringify(body))
    }

    function pair(input, name, cb) {
        let tok = input.trim(), server = ""
        try {
            const j = JSON.parse(tok)
            tok = j.token || ""; server = j.server || ""
        } catch (e) {}
        if (server) Plasmoid.configuration.serverUrl = server
        if (!/^[a-f0-9]{64}$/.test(tok) || !Plasmoid.configuration.serverUrl) { cb(false, i18n("Paste the pairing JSON (or token plus server URL)")); return }
        token = ""
        request("POST", "/companion/v1/pair", { token: tok, name: name || "KDE Plasma" }, (ok, data, msg) => {
            if (!ok || !data || !data.token) { cb(false, msg || i18n("Pairing failed")); return }
            saveToken(data.token, (saved) => {
                if (!saved) { cb(false, i18n("Could not store the credential (secret-tool)")); return }
                error = ""; firstPoll = true; poll(); cb(true, "")
            })
        })
    }

    // ── polling ─────────────────────────────────────────────────────────────
    function poll() {
        if (!paired) return
        request("GET", "/companion/v1/approvals", null, (ok, d, msg) => {
            online = ok
            error = ok ? "" : msg
            if (!ok) return
            requests = d.requests || []
            windows = d.active_windows || []
            fleet = d.fleet_window || { open: false, enabled_until: null }
            notifyNew()
        })
        request("GET", "/companion/v1/quotas", null, (ok, d) => { if (ok) engines = d.engines || [] })
        request("GET", "/companion/v1/rooms", null, (ok, d) => { if (ok) rooms = d.rooms || [] })
        if (roomId) loadRoom(roomId)
    }

    Timer {
        interval: Math.max(5, Plasmoid.configuration.pollSeconds) * 1000
        running: root.paired
        repeat: true
        onTriggered: root.poll()
    }
    Component.onCompleted: loadToken()

    // ── approvals & hosts ───────────────────────────────────────────────────
    function decide(id, approve, minutes) {
        request("POST", "/companion/v1/approvals/" + id + (approve ? "/approve" : "/deny"),
            approve ? { duration_minutes: minutes } : {}, (ok, d, msg) => { if (!ok) error = msg; poll() })
    }
    function enableHost(hostId, minutes) {
        request("POST", "/companion/v1/hosts/" + hostId + "/insecure/enable",
            { duration_minutes: minutes }, (ok, d, msg) => { if (!ok) error = msg; poll() })
    }
    function disableHost(hostId) {
        request("POST", "/companion/v1/hosts/" + hostId + "/insecure/disable", {},
            (ok, d, msg) => { if (!ok) error = msg; poll() })
    }
    function closeFleet() {
        request("POST", "/companion/v1/insecure/window/close", {}, (ok, d, msg) => { if (!ok) error = msg; poll() })
    }

    Notification {
        id: note
        componentName: "plasma_workspace"
        eventId: "notification"
        iconName: "security-low"
        title: i18n("Insecure access requested")
        defaultAction: NotificationAction {
            label: i18n("Open")
            onActivated: root.expanded = true
        }
    }
    function notifyNew() {
        let max = seenMaxId
        let fresh = []
        for (const r of requests) {
            if (r.id > seenMaxId) fresh.push(r)
            if (r.id > max) max = r.id
        }
        seenMaxId = max
        if (firstPoll) { firstPoll = false; return }
        if (fresh.length > 0) {
            note.text = fresh.map(r => r.fqdn + " (" + r.request_ip + ")").join("\n")
            note.sendEvent()
        }
    }

    // ── chats ───────────────────────────────────────────────────────────────
    function uuid() {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0
            return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16)
        })
    }
    function loadRoom(id) {
        roomId = id
        request("POST", "/companion/v1/rooms/read", { room_id: id, limit: 40 }, (ok, d) => {
            if (!ok || !d) return
            const ev = (d.events || []).slice().sort((a, b) => a.created_at < b.created_at ? -1 : 1)
            events = ev
            if (ev.length) request("POST", "/companion/v1/rooms/seen",
                { room_id: id, through: ev[ev.length - 1].created_at }, () => {})
        })
    }
    function sendMessage(text) {
        request("POST", "/companion/v1/rooms/send",
            { room_id: roomId, client_request_id: uuid(), content: text, recipients: [], ask_all: false },
            (ok, d, msg) => { if (!ok) error = msg; loadRoom(roomId) })
    }

    // ── representations ─────────────────────────────────────────────────────
    compactRepresentation: MouseArea {
        onClicked: root.expanded = !root.expanded
        Kirigami.Icon {
            anchors.fill: parent
            source: !root.paired || !root.online ? "security-low"
                : root.pending > 0 ? "security-low" : "security-high"
            opacity: root.online ? 1 : 0.5
        }
        Rectangle {
            visible: root.pending > 0
            anchors { right: parent.right; top: parent.top }
            width: Math.max(height, badge.implicitWidth + 4); height: Kirigami.Units.gridUnit * 0.9
            radius: height / 2
            color: Kirigami.Theme.negativeTextColor
            PlasmaComponents.Label {
                id: badge
                anchors.centerIn: parent
                text: root.pending
                color: "white"
                font.pixelSize: parent.height * 0.7
            }
        }
    }
    fullRepresentation: FullView { app: root }
}
