#!/usr/bin/env bash
set -euo pipefail

# Verify available engine CLIs at startup.
echo "runner: codex $(codex --version 2>/dev/null || echo 'not found')"
echo "runner: claude $(claude --version 2>/dev/null || echo 'not found')"

# Keep the service simple; all configuration flows through request payloads
# or environment variables consumed by app.py.
exec uvicorn app:app --host 0.0.0.0 --port 8080
