"""Exercise manifest selection, checksums and version refusal without networking."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

INSTALLER = Path(__file__).with_name("install-kimi.sh")


@pytest.mark.parametrize("arch,platform", [("amd64", "linux-x64"), ("arm64", "linux-arm64")])
@pytest.mark.parametrize("failure", [None, "checksum", "version", "path", "missing"])
def test_verified_manifest_install_or_refusal(tmp_path, arch, platform, failure):
    if not shutil.which("jq"):
        pytest.skip("jq required by installer")
    fixture = tmp_path / "fixtures"; fixture.mkdir()
    binary = b'#!/bin/sh\nprintf "2.5.3\\n"\n' if failure != "version" else b'#!/bin/sh\nprintf "2.0.0\\n"\n'
    (fixture / "binary").write_bytes(binary)
    checksum = hashlib.sha256(binary).hexdigest() if failure != "checksum" else "0" * 64
    entry = {"filename": "kimi.bin" if failure != "path" else "../unsafe", "checksum": checksum}
    (fixture / "manifest").write_text(json.dumps({"platforms": {platform: entry} if failure != "missing" else {}}))
    tools = tmp_path / "bin"; tools.mkdir()
    curl = tools / "curl"
    curl.write_text('''#!/bin/sh
set -eu
case "$2" in
  */manifest.json) cp "$FIXTURE/manifest" "$4" ;;
  */kimi.bin) cp "$FIXTURE/binary" "$4" ;;
  *) exit 99 ;;
esac
''');curl.chmod(0o755)
    destination = tmp_path / "installed"
    result = subprocess.run(["sh", str(INSTALLER), arch], capture_output=True, text=True,
                            env={**os.environ, "PATH": f"{tools}:{os.defpath}", "FIXTURE": str(fixture),
                                 "KIMI_INSTALL_PATH": str(destination)}, timeout=10)
    if failure:
        assert result.returncode != 0
        assert not destination.exists()
    else:
        assert result.returncode == 0, result.stderr
        assert destination.read_bytes() == binary
        assert destination.stat().st_mode & 0o777 == 0o755


def test_unsupported_architecture_does_not_install(tmp_path):
    destination = tmp_path / "installed"
    result = subprocess.run(["sh", str(INSTALLER), "ppc64le"], capture_output=True, text=True,
                            env={**os.environ, "KIMI_INSTALL_PATH": str(destination)})
    assert result.returncode != 0 and not destination.exists()
    assert "Unsupported Kimi architecture" in result.stderr
