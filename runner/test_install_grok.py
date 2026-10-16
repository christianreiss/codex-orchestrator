"""Installer rejects version drift and corrupt packages before writing a binary."""

import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


INSTALLER = Path(__file__).with_name("install-grok.mjs")
PIN = re.search(r"^const version = '([^']+)';$", INSTALLER.read_text(), re.MULTILINE).group(1)


@unittest.skipUnless(shutil.which("node"), "installer requires Node.js")
class GrokInstallerRefusalTest(unittest.TestCase):
    def run_installer(self, arch, version, fetch_script):
        with tempfile.TemporaryDirectory() as directory:
            preload = Path(directory, "fetch.mjs")
            preload.write_text(fetch_script)
            destination = Path(directory, "grok")
            result = subprocess.run(
                ["node", "--import", str(preload), str(INSTALLER), arch, str(destination)],
                env={**os.environ, "GROK_VERSION": version},
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertNotEqual(0, result.returncode)
            self.assertFalse(destination.exists(), "refused install wrote a binary")
            return result.stderr

    def test_wrong_or_malformed_version_fails_before_download(self):
        for version in ("0.0.0", PIN + "-alpha", "not-a-version"):
            with self.subTest(version=version):
                error = self.run_installer(
                    "amd64", version,
                    "globalThis.fetch = () => { throw Error('unexpected download'); };",
                )
                self.assertIn(f"install-grok.mjs pins Grok {PIN}", error)
                self.assertNotIn("unexpected download", error)

    def test_unsupported_architecture_fails_before_download(self):
        error = self.run_installer(
            "ppc64le", PIN,
            "globalThis.fetch = () => { throw Error('unexpected download'); };",
        )
        self.assertIn("Unsupported Grok architecture", error)
        self.assertNotIn("unexpected download", error)

    def test_corrupt_archive_rejected_before_unpacking_for_both_architectures(self):
        for arch in ("amd64", "arm64"):
            with self.subTest(arch=arch):
                error = self.run_installer(
                    arch, PIN,
                    "globalThis.fetch = async () => ({ ok: true, "
                    "arrayBuffer: async () => new TextEncoder().encode('corrupt archive') });",
                )
                self.assertIn("Grok native package integrity mismatch", error)
