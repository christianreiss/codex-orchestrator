import QtQuick
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami

Kirigami.FormLayout {
    property alias cfg_pollSeconds: poll.value
    property alias cfg_approveMinutes: minutes.value
    property string cfg_serverUrl
    property string cfg_pollSecondsDefault
    property string cfg_approveMinutesDefault
    property string cfg_serverUrlDefault

    QQC2.SpinBox {
        id: poll
        Kirigami.FormData.label: i18n("Refresh interval (s):")
        from: 5
        to: 300
    }
    QQC2.SpinBox {
        id: minutes
        Kirigami.FormData.label: i18n("Default approval (min):")
        from: 1
        to: 480
    }
}
