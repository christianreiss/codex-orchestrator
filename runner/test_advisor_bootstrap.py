"""Fleet Advisor bootstrap, HTTP origin policy and native persona installation."""
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("advisor_bootstrap", Path(__file__).parents[1] / "advisor/bootstrap.py")
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
RedirectPolicy, origin, write_private = bootstrap.RedirectPolicy, bootstrap.origin, bootstrap.write_private


class AdvisorBootstrapTests(unittest.TestCase):
    def test_origin_and_authenticated_redirect(self):
        self.assertEqual(origin("https://EXAMPLE.test/bootstrap"), origin("https://example.test:443/config"))
        req = urllib.request.Request("https://api.example.test/config", headers={"X-API-Key": "fixture"})
        for new in ["http://api.example.test/config", "https://elsewhere.test/config", "https://api.example.test:444/config"]:
            with self.subTest(new=new), self.assertRaises(ValueError):
                RedirectPolicy(False).redirect_request(req, None, 302, "", {}, new)
        same = RedirectPolicy(False).redirect_request(req, None, 302, "", {}, "https://api.example.test/next")
        self.assertEqual(same.get_header("X-api-key"), "fixture")

    def test_artifact_redirect_drops_credentials_for_all_later_hops(self):
        req = urllib.request.Request("https://api.example.test/cxx", headers={"X-API-Key": "fixture", "X-Wrapper-Platform": "linux-amd64"})
        cdn = RedirectPolicy(True).redirect_request(req, None, 302, "", {}, "https://cdn.example.test/cxx")
        back = RedirectPolicy(True).redirect_request(cdn, None, 302, "", {}, "https://api.example.test/last")
        self.assertFalse(cdn.header_items())
        self.assertFalse(back.header_items())

    def test_private_config_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "cdx.json")
            write_private(path, b"first")
            write_private(path, b"second")
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual(os.listdir(directory), ["cdx.json"])
            with open(path, "rb") as fh:
                self.assertEqual(fh.read(), b"second")

    def test_download_and_verify_from_bootstrap_through_loopback(self):
        artifact = b"test-only inert binary fixture"
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, self.headers.get("X-API-Key")))
                if self.path == "/artifact":
                    body = artifact
                else:
                    body = json.dumps({"signature": {"value": "test-signature"}, "payload": {"engine": self.path.rsplit("=", 1)[1], "wrapper": {
                        "version": "fixture", "binary_sha256": self.server.sha256, "binary_url": base + "/artifact",
                    }}}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server, tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = f"http://127.0.0.1:{server.server_port}"
            server.sha256 = hashlib.sha256(artifact).hexdigest()
            boot = root / "bootstrap.json"
            boot.write_text(json.dumps({"base_url": base, "api_key": "fixture"}))
            thread = Thread(target=server.serve_forever)
            thread.start()
            try:
                with patch.object(bootstrap, "CFG_DIR", str(root / "cfg")), patch.object(bootstrap, "BIN_DIR", str(root / "bin")):
                    bootstrap.main(boot)
                    self.assertEqual((root / "bin/cxx").read_bytes(), artifact)
                    self.assertEqual((root / "bin/cxx").stat().st_mode & 0o777, 0o755)
                    self.assertEqual(requests, [(f"/wrapper/v2/config?engine={engine}", "fixture") for engine, _ in bootstrap.ENGINES] + [("/artifact", "fixture")])
                    for engine, persona in (("codex", "cdx"), ("claude", "clx"), ("grok", "cgx"), ("kimi", "ckx")):
                        self.assertEqual(json.loads((root / "cfg" / f"{persona}.json").read_text())["engine"], engine)
                        self.assertEqual((root / "cfg" / f"{persona}.json.sig").read_text(), "test-signature")
                        self.assertEqual((root / "bin" / persona).readlink(), Path("cxx"))
                    bootstrap.main(boot)
                    self.assertEqual(requests.count(("/artifact", "fixture")), 1)
                    server.sha256 = "0" * 64
                    with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                        bootstrap.main(boot)
                    self.assertEqual((root / "bin/cxx").read_bytes(), artifact)
                    self.assertEqual(sorted(p.name for p in (root / "bin").iterdir()), ["cdx", "cgx", "ckx", "clx", "cxx"])
            finally:
                server.shutdown()
                thread.join()
