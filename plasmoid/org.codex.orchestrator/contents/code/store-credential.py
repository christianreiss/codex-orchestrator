"""One-shot handoff from the applet's session bus to secret-tool's private stdin."""

import re
import shutil
import subprocess
import sys

from gi.repository import Gio, GLib


def available():
    if not shutil.which("secret-tool"):
        return False
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        bus.call_sync("org.freedesktop.secrets", "/org/freedesktop/secrets",
                      "org.freedesktop.DBus.Peer", "Ping", None, None, Gio.DBusCallFlags.NONE, 3000)
        return True
    except GLib.Error:
        return False


def main(name):
    if name == "--check":
        return 0 if available() else 1
    if not re.fullmatch(r"org\.kde\.CodexOrchestrator\.x[0-9a-f]{32}", name):
        return 1
    loop = GLib.MainLoop()
    node = Gio.DBusNodeInfo.new_for_xml(
        '<node><interface name="org.kde.CodexOrchestrator.Store">'
        '<method name="Save"><arg type="s" direction="in"/><arg type="s" direction="in"/>'
        '<arg type="s" direction="in"/><arg type="b" direction="out"/></method></interface></node>'
    )
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    saved = False

    def save(connection, sender, path, interface, method, parameters, reply):
        nonlocal saved
        server, applet, token = parameters.unpack()
        if re.fullmatch(r"[0-9]+", applet) and re.fullmatch(r"[A-Za-z0-9_.-]{1,1024}", token):
            try:
                result = subprocess.run(
                    ["secret-tool", "store", "--label=Codex Orchestrator plasmoid",
                     "service", "codex-orchestrator-plasmoid-v2", "server", server, "applet", applet],
                    input=token.encode("ascii"), stdout=subprocess.DEVNULL, timeout=90,
                )
                saved = result.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                pass
        reply.return_value(GLib.Variant("(b)", (saved,)))
        connection.flush_sync()
        loop.quit()

    bus.register_object("/Store", node.interfaces[0], save)
    owner = Gio.bus_own_name_on_connection(bus, name, Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
                                          None, lambda *_: loop.quit())
    GLib.timeout_add_seconds(95, lambda: loop.quit() or False)
    loop.run()
    Gio.bus_unown_name(owner)
    return 0 if saved else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
