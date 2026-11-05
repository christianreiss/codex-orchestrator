import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.plasma.components as PlasmaComponents
import org.kde.kirigami as Kirigami
import org.kde.plasma.plasmoid

ColumnLayout {
    id: view
    property var app
    Layout.minimumWidth: Kirigami.Units.gridUnit * 24
    Layout.minimumHeight: Kirigami.Units.gridUnit * 24
    spacing: Kirigami.Units.smallSpacing

    function ago(iso) {
        if (!iso) return ""
        const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
        return s < 90 ? i18n("%1 s", Math.round(s)) : s < 5400 ? i18n("%1 min", Math.round(s / 60)) : i18n("%1 h", Math.round(s / 3600))
    }
    function until(iso) {
        if (!iso) return ""
        return Qt.formatTime(new Date(iso), "hh:mm")
    }

    // ── pairing ─────────────────────────────────────────────────────────────
    ColumnLayout {
        visible: !app.paired
        Layout.fillWidth: true
        Layout.margins: Kirigami.Units.largeSpacing
        spacing: Kirigami.Units.smallSpacing
        PlasmaComponents.Label {
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            text: i18n("Pair this widget: in the dashboard open Account → Android devices, create a pairing code and paste its JSON here.")
        }
        PlasmaComponents.TextField { id: pairInput; Layout.fillWidth: true; placeholderText: i18n("Pairing JSON or token") }
        PlasmaComponents.TextField { id: serverInput; Layout.fillWidth: true; placeholderText: i18n("Server URL (only if you paste a bare token)"); text: Plasmoid.configuration.serverUrl }
        PlasmaComponents.Button {
            text: i18n("Pair")
            onClicked: {
                if (serverInput.text) Plasmoid.configuration.serverUrl = serverInput.text
                app.pair(pairInput.text, "KDE Plasma", (ok, msg) => { pairMsg.text = ok ? "" : msg; if (ok) pairInput.text = "" })
            }
        }
        PlasmaComponents.Label { id: pairMsg; Layout.fillWidth: true; color: Kirigami.Theme.negativeTextColor; wrapMode: Text.Wrap }
        PlasmaComponents.Label { visible: app.error !== ""; text: app.error; color: Kirigami.Theme.negativeTextColor; wrapMode: Text.Wrap; Layout.fillWidth: true }
    }

    // ── main ────────────────────────────────────────────────────────────────
    PlasmaComponents.TabBar {
        id: tabs
        visible: app.paired
        Layout.fillWidth: true
        PlasmaComponents.TabButton { text: app.pending > 0 ? i18n("Requests (%1)", app.pending) : i18n("Requests") }
        PlasmaComponents.TabButton { text: i18n("Hosts") }
        PlasmaComponents.TabButton { text: i18n("Quotas") }
        PlasmaComponents.TabButton { text: i18n("Chats") }
    }
    PlasmaComponents.Label {
        visible: app.paired && app.error !== ""
        Layout.fillWidth: true
        text: app.error
        color: Kirigami.Theme.negativeTextColor
        wrapMode: Text.Wrap
    }

    StackLayout {
        visible: app.paired
        Layout.fillWidth: true
        Layout.fillHeight: true
        currentIndex: tabs.currentIndex

        // Requests
        ListView {
            clip: true
            model: app.requests
            spacing: Kirigami.Units.smallSpacing
            QQC2.Label { anchors.centerIn: parent; visible: parent.count === 0; text: i18n("No pending requests"); opacity: 0.6 }
            delegate: ColumnLayout {
                width: ListView.view.width
                required property var modelData
                PlasmaComponents.Label { text: modelData.fqdn; font.bold: true; Layout.fillWidth: true; elide: Text.ElideRight }
                PlasmaComponents.Label { text: modelData.request_ip + " · " + view.ago(modelData.requested_at); opacity: 0.7 }
                RowLayout {
                    PlasmaComponents.Button {
                        text: i18n("Approve %1 min", Plasmoid.configuration.approveMinutes)
                        icon.name: "dialog-ok"
                        onClicked: app.decide(modelData.id, true, Plasmoid.configuration.approveMinutes)
                    }
                    PlasmaComponents.Button {
                        text: i18n("Deny")
                        icon.name: "dialog-cancel"
                        onClicked: app.decide(modelData.id, false, 0)
                    }
                }
                Kirigami.Separator { Layout.fillWidth: true }
            }
        }

        // Hosts
        ColumnLayout {
            RowLayout {
                Layout.fillWidth: true
                PlasmaComponents.Label {
                    Layout.fillWidth: true
                    text: app.fleet.open ? i18n("Fleet window open until %1", view.until(app.fleet.enabled_until)) : i18n("No fleet window")
                }
                PlasmaComponents.Button {
                    visible: app.fleet.open
                    text: i18n("Close fleet window")
                    onClicked: app.closeFleet()
                }
            }
            ListView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                model: app.windows
                QQC2.Label { anchors.centerIn: parent; visible: parent.count === 0; text: i18n("No open host windows"); opacity: 0.6 }
                delegate: RowLayout {
                    width: ListView.view.width
                    required property var modelData
                    ColumnLayout {
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: modelData.fqdn; Layout.fillWidth: true; elide: Text.ElideRight }
                        PlasmaComponents.Label {
                            text: i18n("until %1", view.until(modelData.enabled_until)) + (modelData.domain_allow ? " · " + modelData.domain_allow : "")
                            opacity: 0.7
                        }
                    }
                    PlasmaComponents.Button {
                        text: i18n("+%1 min", Plasmoid.configuration.approveMinutes)
                        onClicked: app.enableHost(modelData.host_id, Plasmoid.configuration.approveMinutes)
                    }
                    PlasmaComponents.Button {
                        text: i18n("Close")
                        onClicked: app.disableHost(modelData.host_id)
                    }
                }
            }
            PlasmaComponents.Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                opacity: 0.6
                text: i18n("Opening a window for a closed host needs its host id; extend or close the windows listed above, and approve new requests under Requests.")
            }
        }

        // Quotas
        ListView {
            clip: true
            model: app.engines
            delegate: ColumnLayout {
                width: ListView.view.width
                required property var modelData
                PlasmaComponents.Label { text: modelData.label + (modelData.enabled ? "" : " (" + i18n("suspended") + ")"); font.bold: true }
                Repeater {
                    model: modelData.accounts
                    delegate: ColumnLayout {
                        required property var modelData
                        Layout.fillWidth: true
                        PlasmaComponents.Label { text: modelData.label + (modelData.stale ? " · " + i18n("stale") : ""); opacity: 0.8 }
                        Repeater {
                            model: modelData.windows
                            delegate: RowLayout {
                                required property var modelData
                                Layout.fillWidth: true
                                PlasmaComponents.Label { text: modelData.kind; Layout.preferredWidth: Kirigami.Units.gridUnit * 4 }
                                PlasmaComponents.ProgressBar {
                                    Layout.fillWidth: true
                                    from: 0; to: 100
                                    value: modelData.used_percent === null ? 0 : modelData.used_percent
                                }
                                PlasmaComponents.Label {
                                    text: modelData.used_percent === null ? i18n("n/a") : Math.round(modelData.used_percent) + " %"
                                    Layout.preferredWidth: Kirigami.Units.gridUnit * 3
                                }
                            }
                        }
                    }
                }
                Kirigami.Separator { Layout.fillWidth: true }
            }
        }

        // Chats
        ColumnLayout {
            PlasmaComponents.ComboBox {
                id: roomBox
                Layout.fillWidth: true
                model: app.rooms
                textRole: "title"
                displayText: currentIndex >= 0 && app.rooms[currentIndex]
                    ? app.rooms[currentIndex].title + (app.rooms[currentIndex].unread ? " (" + app.rooms[currentIndex].unread + ")" : "")
                    : i18n("Select a room")
                currentIndex: -1
                onActivated: (i) => app.loadRoom(app.rooms[i].id)
            }
            ListView {
                id: chatList
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                model: app.events
                onCountChanged: positionViewAtEnd()
                delegate: ColumnLayout {
                    width: ListView.view.width
                    required property var modelData
                    PlasmaComponents.Label { text: (modelData.name || modelData.actor) + " · " + view.ago(modelData.created_at); opacity: 0.7; font.pointSize: Kirigami.Theme.smallFont.pointSize }
                    PlasmaComponents.Label { text: modelData.content; wrapMode: Text.Wrap; Layout.fillWidth: true }
                }
            }
            RowLayout {
                Layout.fillWidth: true
                enabled: app.roomId !== ""
                PlasmaComponents.TextField {
                    id: chatInput
                    Layout.fillWidth: true
                    placeholderText: i18n("Message")
                    onAccepted: send.clicked()
                }
                PlasmaComponents.Button {
                    id: send
                    icon.name: "mail-send"
                    onClicked: { if (chatInput.text.trim() !== "") { app.sendMessage(chatInput.text); chatInput.text = "" } }
                }
            }
        }
    }

    RowLayout {
        visible: app.paired
        Layout.fillWidth: true
        PlasmaComponents.Label { Layout.fillWidth: true; text: app.online ? i18n("Connected") : i18n("Offline"); opacity: 0.6 }
        PlasmaComponents.ToolButton { icon.name: "view-refresh"; onClicked: app.poll() }
        PlasmaComponents.ToolButton { icon.name: "network-disconnect"; onClicked: app.unpair() }
    }
}
