#!/usr/bin/env bash
set -euo pipefail

# Report what this image actually carries, and refuse to serve if a required
# engine is missing or drifted from the version the image was built with.
# `app.py` makes the same assertion at import; doing it here first turns a
# uvicorn traceback into one readable line in `docker logs`.
python -c '
import sys
import runner_engines

snapshot = runner_engines.runtime_snapshot()
required = runner_engines.required_engines()
for engine, state in snapshot.items():
    print(f"runner: {engine} {state.version or state.detail}")
problems = runner_engines.readiness_problems(snapshot, required)
if problems:
    print("runner: refusing to start -> " + "; ".join(problems), file=sys.stderr)
    sys.exit(1)
'

# Keep the service simple; all configuration flows through request payloads
# or environment variables consumed by app.py.
exec uvicorn app:app --host 0.0.0.0 --port 8080
