"""Advisor provisioning must fetch the selected Kimi config instead of another persona."""
import hashlib
import importlib.util
import json
from pathlib import Path


def test_bootstrap_installs_all_engine_personas(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("advisor_bootstrap", Path(__file__).parents[1] / "advisor/bootstrap.py")
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    monkeypatch.setattr(bootstrap, "CFG_DIR", str(tmp_path / "config"))
    monkeypatch.setattr(bootstrap, "BIN_DIR", str(tmp_path / "bin"))
    binary = b"test shared binary"
    calls = []

    def fetch(url, key, platform):
        calls.append(url)
        if url == "https://fleet.test/binary":
            return binary
        engine = url.rsplit("=", 1)[1]
        return json.dumps({"payload": {"engine": engine, "wrapper": {"binary_url": "https://fleet.test/binary", "binary_sha256": hashlib.sha256(binary).hexdigest(), "version": "test"}}, "signature": {"value": "test-signature"}}).encode()

    monkeypatch.setattr(bootstrap, "fetch", fetch)
    path = tmp_path / "bootstrap.json"
    path.write_text(json.dumps({"base_url": "https://fleet.test", "api_key": "test"}))
    bootstrap.main(path)
    assert calls == [f"https://fleet.test/wrapper/v2/config?engine={engine}" for engine in ("codex", "claude", "grok", "kimi")] + ["https://fleet.test/binary"]
    for engine, persona in (("codex", "cdx"), ("claude", "clx"), ("grok", "cgx"), ("kimi", "ckx")):
        assert json.loads((tmp_path / "config" / f"{persona}.json").read_text())["engine"] == engine
        assert (tmp_path / "config" / f"{persona}.json.sig").read_text() == "test-signature"
        assert (tmp_path / "bin" / persona).readlink() == Path("cxx")
    assert (tmp_path / "bin/cxx").read_bytes() == binary
