#!/usr/bin/env bash
set -euo pipefail

# Keep the service simple; all configuration flows through request payloads
# or environment variables consumed by app.py.
exec uvicorn app:app --host 0.0.0.0 --port 8080
