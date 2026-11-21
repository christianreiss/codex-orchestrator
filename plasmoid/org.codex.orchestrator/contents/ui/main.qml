import QtQuick
import QtQuick.Layouts
import org.kde.plasma.plasmoid
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.plasma5support as P5Support
import org.kde.kirigami as Kirigami
import org.kde.plasma.workspace.dbus as DBus
import org.kde.notification

PlasmoidItem {
    id: root

    readonly property string secretService: "codex-orchestrator-plasmoid-v2"
    readonly property string storeCommand: "python3 " + quote(decodeURIComponent(Qt.resolvedUrl("../code/store-credential.py").toString().slice(7)))
    property var pendingStore: null
    property bool pairing: false
    property string disconnecting: ""
    property int sessionGeneration: 0
    property string token: ""
    property string pairedServer: ""
    property bool secretLoaded: false
    property bool online: false
    property string error: ""
    property var requests: []
    property var windows: []
    property var fleet: ({ open: false, enabled_until: null })
    property var engines: []
    property var rooms: []
    readonly property alias events: history.events
    readonly property alias roomId: history.roomId
    property int seenMaxId: 0
    property bool firstPoll: true
    readonly property bool paired: token !== "" && pairedServer !== ""
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

    function quote(value) {
        return "'" + value.replace(/'/g, "'\\''") + "'"
    }
    function secretAttributes(server) {
        return "service " + secretService + " server " + quote(server) + " applet " + quote(String(Plasmoid.id))
    }
    function loadToken() {
        const server = Plasmoid.configuration.serverUrl
        if (!Plasmoid.configuration.credentialActive) {
            secretLoaded = true
            if (server) error = i18n("Pair this widget again to bind its credential to this server. Revoke the previous device in your account.")
            return
        }
        shell.run("secret-tool lookup " + secretAttributes(server), (code, out) => {
            secretLoaded = true
            if (code !== 0 || !out) {
                error = i18n("Unlock your keyring and reopen the widget, or pair again.")
                return
            }
            pairedServer = server; token = out
            poll()
        })
    }
    // The executable data engine accepts commands but has no private stdin. Hand
    // the credential to the one-shot helper on this user's session bus instead.
    DBus.DBusServiceWatcher {
        watchedService: root.pendingStore ? root.pendingStore.name : ""
        busType: DBus.BusType.Session
        onRegisteredChanged: {
            const pending = root.pendingStore
            if (registered && pending && !pending.sent) {
                pending.sent = true
                pending.reply = DBus.SessionBus.asyncCall({
                    service: pending.name, path: "/Store", iface: "org.kde.CodexOrchestrator.Store",
                    member: "Save", signature: "(sss)", arguments: [pending.server, String(Plasmoid.id), pending.token]
                })
            }
        }
    }
    function saveToken(server, t, cb) {
        const name = "org.kde.CodexOrchestrator.x" + uuid().replace(/-/g, "")
        pendingStore = { name: name, server: server, token: t, sent: false }
        shell.run(storeCommand + " " + name, (code) => {
            pendingStore = null
            if (code !== 0) { cb(false); return }
            shell.run("secret-tool lookup " + secretAttributes(server), (lookupCode, stored) => {
                if (lookupCode !== 0 || stored !== t) { cb(false); return }
                Plasmoid.configuration.serverUrl = server
                Plasmoid.configuration.credentialActive = true
                pairedServer = server
                token = t
                cb(true)
            })
        })
    }
    function clearPairing(message) {
        const server = pairedServer
        sessionGeneration++
        Plasmoid.configuration.credentialActive = false
        Plasmoid.configuration.deviceId = ""
        Plasmoid.configuration.serverUrl = ""
        token = ""; pairedServer = ""; online = false; requests = []; windows = []; rooms = []; history.clear()
        engines = []; fleet = { open: false, enabled_until: null }
        firstPoll = true; seenMaxId = 0; error = message
        if (server) {
            secretLoaded = false
            shell.run("secret-tool clear " + secretAttributes(server), () => { secretLoaded = true })
        }
    }
    function clearRevocationNotice(reference) {
        Plasmoid.configuration.pendingRevocations =
            Plasmoid.configuration.pendingRevocations.filter(item => item !== reference)
    }
    function unpair() {
        if (!paired) return
        const server = pairedServer, bearer = token
        const device = Plasmoid.configuration.deviceId
        const reference = device ? server + " (" + device + ")" : server
        const prior = Plasmoid.configuration.pendingRevocations
        if (!prior.includes(reference)) Plasmoid.configuration.pendingRevocations = [...prior, reference]
        disconnecting = reference
        clearPairing("")
        // Use only the captured credential for this single attempt. A crash or
        // missing response leaves the nonsecret device reference for the operator.
        request("DELETE", "/companion/v1/device", null, (ok, ignored, message, status) => {
            disconnecting = ""
            if (ok || status === 401) clearRevocationNotice(reference)
        }, server, bearer)
    }

    // ── HTTP ────────────────────────────────────────────────────────────────
    function request(method, path, body, cb, server = pairedServer, bearer = token) {
        const generation = sessionGeneration
        const xhr = new XMLHttpRequest()
        let done = false
        function finish(ok, data, message, status) {
            if (done || generation !== sessionGeneration) return
            done = true
            if (status === 401 && bearer && bearer === token) {
                clearPairing(i18n("Device revoked; pair again"))
                return
            }
            cb(ok, data, message, status)
        }
        xhr.open(method, server.replace(/\/+$/, "") + path)
        if (bearer) xhr.setRequestHeader("Authorization", "Bearer " + bearer)
        if (body !== null && body !== undefined) xhr.setRequestHeader("Content-Type", "application/json")
        xhr.timeout = 15000
        xhr.onreadystatechange = () => {
            if (xhr.readyState !== XMLHttpRequest.DONE) return
            let json = null
            try { json = JSON.parse(xhr.responseText) } catch (e) {}
            const ok = xhr.status >= 200 && xhr.status < 300
            finish(ok, json && json.data !== undefined ? json.data : json,
                ok ? "" : (json && json.message) || (xhr.status ? "HTTP " + xhr.status : i18n("Network error")), xhr.status)
        }
        xhr.ontimeout = () => finish(false, null, i18n("Timeout"), 0)
        xhr.onerror = () => finish(false, null, i18n("Network error"), 0)
        xhr.send(body === null || body === undefined ? undefined : JSON.stringify(body))
    }

    function pair(input, fallbackServer, name, cb) {
        if (pairing || !secretLoaded || paired) return
        let tok = input.trim(), server = fallbackServer.trim()
        try {
            const j = JSON.parse(tok)
            tok = typeof j.token === "string" ? j.token : ""
            if (j.server !== undefined) server = typeof j.server === "string" ? j.server : ""
        } catch (e) {}
        server = server.replace(/\/+$/, "")
        if (!/^[a-f0-9]{64}$/.test(tok) || !/^https:\/\/([A-Za-z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]+)?$/.test(server)) {
            cb(false, i18n("Paste the pairing JSON, or enter a token and its HTTPS server origin")); return
        }
        pairing = true
        shell.run(storeCommand + " --check", code => {
            if (code !== 0) {
                pairing = false
                cb(false, i18n("Pairing needs Python 3 with Gio, secret-tool and a running Secret Service."))
                return
            }
            redeem(server, tok, name, cb)
        })
    }

    function redeem(server, tok, name, cb) {
        request("POST", "/companion/v1/pair", { token: tok, name: name || "KDE Plasma" }, (ok, data, msg, status) => {
            if (!ok || !data || !data.token) {
                pairing = false
                if (status === 0 || status >= 500 || ok) {
                    cb(false, i18n("Pairing could not be confirmed. Open Account → Companion devices at %1, revoke the new KDE Plasma device if present, then create a new pairing code.", server), true)
                } else {
                    cb(false, msg || i18n("Pairing failed"))
                }
                return
            }
            saveToken(server, data.token, (saved) => {
                if (!saved) {
                    request("DELETE", "/companion/v1/device", null, (revoked, ignored, reason, status) => {
                        pairing = false
                        cb(false, revoked || status === 401
                            ? i18n("The device credential could not be stored. Unlock your keyring and pair again.")
                            : i18n("Credential storage failed. Revoke this KDE Plasma device in your account before pairing again."))
                    }, server, data.token)
                    return
                }
                Plasmoid.configuration.deviceId = data.device_id || ""
                pairing = false; error = ""; firstPoll = true; poll(); cb(true, "")
            })
        }, server, "")
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
        request("GET", "/companion/v1/rooms", null, (ok, d) => {
            if (!ok) return
            rooms = d.rooms || []
            if (roomId && !rooms.some(room => room.id === roomId)) history.clear()
        })
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
    RoomHistory {
        id: history
        request: (method, path, body, cb) => root.request(method, path, body, cb)
    }
    function loadRoom(id) { history.loadRoom(id) }
    function sendMessage(id, requestId, text, cb) {
        request("POST", "/companion/v1/rooms/send",
            { room_id: id, client_request_id: requestId, content: text, recipients: [], ask_all: false },
            (ok, d, msg, status) => {
                if (id === roomId) loadRoom(id)
                cb(ok, ok ? "" : (status === 0 || status >= 500
                    ? i18n("Delivery could not be confirmed. Retry the unchanged message to check its result.")
                    : msg))
            })
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
