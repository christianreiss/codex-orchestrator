import asyncio
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import chatty
import grok


class ChattyTest(unittest.TestCase):
    def test_engine_commands_disable_native_tools(self):
        with tempfile.TemporaryDirectory() as home:
            for engine in ("codex", "claude", "grok"):
                request = chatty.TurnRequest(protocol=1, engine=engine, model="test", auth_json={}, prompt="test")
                cmd, _, _ = chatty.commands(request, home, "claude", grok)
                if engine == "codex":
                    self.assertIn("features.shell_tool=false", cmd)
                    self.assertIn("features.unified_exec=false", cmd)
                    self.assertIn("mcp_servers={}", cmd)
                    self.assertIn("--ephemeral", cmd)
                elif engine == "claude":
                    self.assertEqual("", cmd[cmd.index("--tools") + 1])
                    self.assertIn("--strict-mcp-config", cmd)
                    self.assertIn("--no-session-persistence", cmd)
                else:
                    self.assertEqual("*", cmd[cmd.index("--deny") + 1])
                    self.assertIn("--no-subagents", cmd)

    def test_protocol_rejects_non_object_or_unrecognized_output(self):
        for value in ('[]', 'hello', '{"kind":"shell"}', '```json\n{}\n```'):
            with self.assertRaises(HTTPException):
                chatty.validate_response(value)

    def test_bounded_reader(self):
        async def exercise():
            stream = asyncio.StreamReader()
            stream.feed_data(b"x" * (chatty.MAX_OUTPUT + 1))
            stream.feed_eof()
            with self.assertRaises(HTTPException):
                await chatty.bounded_read(stream)
        asyncio.run(exercise())

    def app(self, homes):
        app = FastAPI()
        def auth(request):
            if request.headers.get("x-runner-auth") != "test":
                raise HTTPException(401, "unauthorized")
        def prepare(_auth, _engine):
            home = tempfile.mkdtemp(prefix="chatty-test-")
            homes.append(home)
            return {"HOME": home, "PATH": os.defpath, "RUNNER_SHARED_SECRET": "never-in-child", "DATABASE_PASSWORD": "never-in-child"}, home, None
        chatty.register_chatty(app, auth, prepare, "claude", grok, {"codex": types.SimpleNamespace(available=True), "grok": types.SimpleNamespace(available=False)})
        return TestClient(app)

    def test_real_subprocess_output_cleanup_and_environment_isolation(self):
        homes = []
        client = self.app(homes)
        def command(_request, home, *_):
            output = str(Path(home) / "answer.txt")
            script = "import os,json,pathlib; assert 'RUNNER_SHARED_SECRET' not in os.environ; assert 'DATABASE_PASSWORD' not in os.environ; pathlib.Path('answer.txt').write_text(json.dumps({'kind':'answer','text':'Hallo','sources':[]}))"
            return [sys.executable, "-c", script], b"", output
        with patch.object(chatty, "commands", command):
            response = client.post("/chatty/turn", headers={"x-runner-auth": "test"}, json={"protocol": 1, "engine": "codex", "model": "test", "auth_json": {}, "prompt": "test"})
        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual("Hallo", response.json()["response"]["text"])
        self.assertTrue(homes)
        self.assertFalse(os.path.exists(homes[0]))

    def test_timeout_kills_process_and_cleans_home(self):
        homes = []
        client = self.app(homes)
        with patch.object(chatty, "commands", lambda *_: ([sys.executable, "-c", "import time; time.sleep(20)"], None, None)):
            response = client.post("/chatty/turn", headers={"x-runner-auth": "test"}, json={"protocol": 1, "engine": "codex", "model": "test", "auth_json": {}, "prompt": "test", "timeout_seconds": 1})
        self.assertEqual(504, response.status_code)
        self.assertFalse(os.path.exists(homes[0]))

    def test_capabilities_are_authenticated_and_omit_missing_engines(self):
        client = self.app([])
        self.assertEqual(401, client.get("/chatty/capabilities").status_code)
        self.assertEqual({"protocol": 1, "engines": ["codex"]}, client.get("/chatty/capabilities", headers={"x-runner-auth": "test"}).json())


class KimiChattyTest(unittest.TestCase):
    def test_private_kimi_env_survives_transport_and_parses_native_output(self):
        import kimi
        import time
        homes = []
        app = FastAPI()
        def prepare(auth, engine):
            self.assertEqual("kimi", engine)
            env, home, path = kimi.prepare_env(auth, tempfile.gettempdir(), 900)
            homes.append(home)
            env["RUNNER_SHARED_SECRET"] = "must-not-inherit"
            return env, home, path
        chatty.register_chatty(app, lambda _: None, prepare, "claude", grok,
                              {"kimi": types.SimpleNamespace(available=True)}, kimi)
        script = '''import os,json
assert os.environ['KIMI_DISABLE_TELEMETRY'] == '1'
assert os.environ['KIMI_CODE_NO_AUTO_UPDATE'] == '1'
assert 'RUNNER_SHARED_SECRET' not in os.environ
assert os.path.exists(os.path.join(os.environ['KIMI_CODE_HOME'],'credentials','kimi-code.json'))
print(json.dumps({'role':'assistant','content':json.dumps({'kind':'answer','text':'OK'})}))
'''
        with patch.object(chatty, "commands", lambda *_: ([sys.executable, "-c", script], None, None)):
            response = TestClient(app).post("/chatty/turn", json={"protocol": 1, "engine": "kimi", "model": "k3", "prompt": "hi",
                "auth_json": {"kimi_code": {"access_token": "test", "expires_at": time.time()+1800}, "device_id": "b"*32}})
        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual("OK", response.json()["response"]["text"])
        self.assertFalse(Path(homes[0]).exists())

    def test_kimi_command_selects_stream_json(self):
        import kimi
        with tempfile.TemporaryDirectory() as home:
            payload = chatty.TurnRequest(protocol=1, engine="kimi", model="k3", auth_json={}, prompt="hi")
            cmd, stdin, output = chatty.commands(payload, home, "claude", grok, kimi)
            self.assertEqual("stream-json", cmd[cmd.index("--output-format")+1])
            self.assertEqual("kimi-code/k3", cmd[cmd.index("-m")+1])
            self.assertIsNone(stdin)
