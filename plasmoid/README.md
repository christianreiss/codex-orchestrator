# Codex Orchestrator for KDE Plasma

The panel widget approves or denies insecure host requests, extends or closes open windows, displays engine quotas and reads or sends room messages. It uses the same paired-device API as the Android Companion. Actions require the signed-in operator's corresponding capabilities, including `hosts.activate_insecure` for approvals.

## Install and pair

Version 0.2 needs Plasma 6.2 or later with `org.kde.plasma.workspace.dbus` and Plasma 5 Support, Python 3 with PyGObject/Gio, libsecret's `secret-tool` and a desktop Secret Service. GNOME Keyring and KDE's Secret Service are examples. Keep the desktop keyring unlocked for pairing.

From this directory run `kpackagetool6 -t Plasma/Applet -i org.codex.orchestrator` or use `-u` to upgrade. Add **Codex Orchestrator** to the panel. Open **Account → Companion devices** in the dashboard, create a pairing code and paste the JSON into the widget. A bare code also requires its HTTPS server origin. If dependencies are unavailable, the widget reports the missing requirements before consuming the code.

The server issues a one-year device credential. The widget stores it in the user's Secret Service, scoped to both server origin and Plasma applet ID. A one-shot helper accepts the value over the session D-Bus and passes it to `secret-tool` on stdin. The Plasma config contains the server origin, the public device ID and a pairing flag. Later starts look up the existing credential. The widget attempts to revoke a just-created device when storage fails. If the response to the first pairing request is lost, check **Account → Companion devices** at the displayed server. Revoke the new KDE Plasma device if present, then obtain a fresh code. The same account screen lets you revoke a device after a failed credential write.

**Upgrading from 0.1:** Open the dashboard at the original server, identify the previous KDE Plasma device and revoke that specific device. Create a fresh code there and pair the upgraded widget. Version 0.1 kept a single Secret Service entry without a server or widget identifier. Version 0.2 leaves this entry available to remaining 0.1 instances and prompts for the fresh pairing. Only after all those instances have been replaced, remove the old local entry with `secret-tool clear service codex-orchestrator-plasmoid`.

## Use and verify

Choose a room in **Chats** to enable the composer. If delivery is uncertain, retry the unchanged draft. The widget reuses its original request ID. Changing the text starts a new request. Drafts are held in memory per room and clear on unpairing. The disconnect button clears local access and sends one revocation request using the former credential. If the response is lost, the widget keeps the original server and public device ID as a reminder across restarts. Check that device in the original server’s account screen, revoke it if needed, and acknowledge the reminder. Revoke a device in the dashboard to cut server access. On the next unauthorized response the widget clears the local pairing and prompts again.

`python3 test/credential_store.py` exercises the one-shot helper on a fresh session D-Bus with a disposable fake Secret Service client. `QT_QPA_PLATFORM=offscreen /usr/lib64/qt6/bin/qmltestrunner -input test` runs the production room reader with deliberately reordered replies on Fedora. The [widget acceptance report](../docs/reports/plasma-widget-acceptance.md) records the real X11, HTTPS, keyring and MySQL checks.
