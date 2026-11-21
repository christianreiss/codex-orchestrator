"""Exercise the one-shot widget bridge on a private session bus with a fake keyring."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

from gi.repository import Gio, GLib


HELPER = (Path(__file__).resolve().parents[1] /
          "org.codex.orchestrator/contents/code/store-credential.py")
SECRET = "fixture-bearer"
SERVER = "https://widget.example.invalid"


class CredentialStore(unittest.TestCase):
    def test_handoff(self):
        for value, returncode, expect_save in ((SECRET, 0, True), (SECRET, 1, False), ("a b", 0, False)):
            with self.subTest(value=value, returncode=returncode), tempfile.TemporaryDirectory() as datadir:
                data = Path(datadir)
                cli = data / "secret-tool"
                cli.write_text(
                    "#!" + sys.executable + "\n"
                    "import json,os,sys\nfrom pathlib import Path\n"
                    "Path(os.environ['FIXTURE']).write_text(json.dumps([sys.argv[1:],sys.stdin.read()]))\n"
                    "sys.exit(int(os.environ['EXIT']))\n"
                )
                cli.chmod(0o700)
                evidence = data / "captured.json"
                env = dict(os.environ, PATH=str(data), FIXTURE=str(evidence), EXIT=str(returncode))
                bus_name = "org.kde.CodexOrchestrator.x" + uuid.uuid4().hex
                with subprocess.Popen([sys.executable, str(HELPER), bus_name], env=env) as child:
                    try:
                        bus = Gio.bus_get_sync(Gio.BusType.SESSION)
                        deadline = time.monotonic() + 5
                        while time.monotonic() < deadline:
                            owns = bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
                                "org.freedesktop.DBus", "NameHasOwner", GLib.Variant("(s)", (bus_name,)),
                                None, Gio.DBusCallFlags.NONE, 1000).unpack()[0]
                            if owns:
                                break
                            time.sleep(0.02)
                        else:
                            self.fail("helper did not register on the private session bus")
                        result = bus.call_sync(bus_name, "/Store", "org.kde.CodexOrchestrator.Store",
                            "Save", GLib.Variant("(sss)", (SERVER, "4", value)), None,
                            Gio.DBusCallFlags.NONE, 3000).unpack()[0]
                        self.assertEqual(expect_save, result)
                        self.assertEqual(0 if expect_save else 1, child.wait(3))
                    finally:
                        if child.poll() is None:
                            child.kill()
                if value == SECRET:
                    args, stdin = json.loads(evidence.read_text())
                    self.assertEqual(args, ["store", "--label=Codex Orchestrator plasmoid", "service",
                                           "codex-orchestrator-plasmoid-v2", "server", SERVER, "applet", "4"])
                    self.assertEqual(stdin, value)
                else:
                    self.assertFalse(evidence.exists())

    def test_missing_cli_is_detected_before_pairing(self):
        with tempfile.TemporaryDirectory() as empty:
            result = subprocess.run([sys.executable, str(HELPER), "--check"],
                                    env=dict(os.environ, PATH=empty), check=False)
            self.assertEqual(result.returncode, 1)


if __name__ == "__main__":
    if sys.argv[1:] == ["--private"]:
        unittest.main(argv=[__file__])
    else:
        sys.exit(subprocess.call(["dbus-run-session", "--", sys.executable, __file__, "--private"]))
