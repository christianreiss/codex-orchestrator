"""Optional acceptance with the pinned real CLI and a local fake inference API.

KIMI_TEST_BINARY=/path/to/kimi enables this; no subscription token is consumed.
"""
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

import kimi


@pytest.mark.skipif(not os.environ.get("KIMI_TEST_BINARY"), reason="set KIMI_TEST_BINARY for native acceptance")
@pytest.mark.parametrize("region", ["com", "ai"])
def test_native_access_projection_stream_and_tool_denial(tmp_path, region):
    calls = []
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            calls.append((self.path, self.headers.get("Authorization")))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            if len(requests) == 1:
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "tool-test", "type": "function",
                    "function": {"name": "Bash", "arguments": '{"command":"touch escaped"}'}}]}
                reason = "tool_calls"
            else:
                delta = {"role": "assistant", "content": "OK"}
                reason = "stop"
            for chunk in [
                {"id": "test", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                {"id": "test", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": reason}],
                 "usage": {"prompt_tokens": 12, "completion_tokens": 1, "total_tokens": 13}},
            ]:
                self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    payload = {"kimi_code": {"access_token": "local-test-access", "refresh_token": "must-never-refresh",
                             "expires_at": time.time()+1800}, "device_id": "a"*32, "base_url": f"https://api.kimi.{region}/coding/v1",
               "oauth_host": f"https://auth.kimi.{region}"}
    env, home, path = kimi.prepare_env(payload, str(tmp_path), 900)
    try:
        config = Path(env["KIMI_CODE_HOME"], "config.toml")
        # Test-only redirect of the managed provider to a local fake API.
        config.write_text(config.read_text().replace('model = "kimi-for-coding"',
            f'model = "kimi-for-coding"\nprotocol = "openai"\nbase_url = "http://127.0.0.1:{server.server_port}/v1"'))
        cmd = kimi.build_command("Reply OK", home)
        cmd[0] = os.environ["KIMI_TEST_BINARY"]
        result = subprocess.run(cmd, env=env, cwd=home, text=True, capture_output=True, timeout=20)
        assert result.returncode == 0, result.stderr
        assert not Path(home, "escaped").exists()
        assert calls and all(auth == "Bearer local-test-access" for _, auth in calls)
        assert all(url == "/v1/chat/completions" for url, _ in calls)
        assert json.loads(Path(path).read_text())["refresh_token"] == ""
        # A denied native tool call is still surfaced as a tool message. Our
        # inference boundary refuses that transcript rather than claim success.
        assert '"role":"assistant"' in result.stdout
        assert kimi.parse_result(result.stdout) is None
        assert len(requests) == 2
        assert not requests[0].get("tools"), "native tools leaked onto inference request"
    finally:
        server.shutdown(); thread.join(timeout=2)
