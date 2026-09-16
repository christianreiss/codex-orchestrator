# Receiver verification — 2026-09-16

Verified locally on Linux against the cxx 0.8.9 worktree. This is implementation
verification, not a fleet rollout. Existing sessions were not restarted.

## Native model evidence

`wrappers/scripts/receiver-canary.py` started each native terminal CLI with a
private fixture broker and temporary working directory. Each model acknowledged
both source nonces, returned an exactly correlated ordinary peer reply and portal
reply, then reconnected under a new generation and acknowledged fresh challenges
in the same native conversation. No fleet peer was messaged.

| Engine | Installed CLI | Result |
| --- | --- | --- |
| codex | codex-cli 0.153.4 | Both sources, replies and reconnect verified |
| claude | 2.1.273 (Claude Code) | Both sources, replies and reconnect verified |

Machine-readable canary results (nonces omitted):

```json
[
  {
    "engine": "codex",
    "result": "passed",
    "native_session_id": "01a0aaa2-936d-7a73-8e0d-916633c79aa4",
    "generation": "ce8ebda1-b40a-401e-b346-1efa16acb2cf",
    "model_acknowledged_sources": [
      "peer",
      "portal"
    ],
    "correlated_message_replies": [
      "peer",
      "portal"
    ],
    "reconnected_and_reverified": true
  },
  {
    "engine": "claude",
    "result": "passed",
    "native_session_id": "0cb6e96b-1f69-4c05-9e97-14bcb2a5b318",
    "generation": "d5040e7b-deeb-4960-a1e1-21725f5a869b",
    "model_acknowledged_sources": [
      "peer",
      "portal"
    ],
    "correlated_message_replies": [
      "peer",
      "portal"
    ],
    "reconnected_and_reverified": true
  }
]
```

Tested wrapper SHA-256: `7c2666f38465f714d5c907f204ea7a8d935408091a47d726dda6b3e994617f69`.

## Regression and build checks

- API typecheck and changed-service lint: passed (one pre-existing unused-helper warning).
- API service/contract suites: passed after updating the deliberately changed
  managed-guidance digest fixtures; the 51-test guidance/liveness rerun passed.
- Isolated MySQL migration and 115 messaging/portal integration tests: passed,
  including independent source proof, old-generation rejection, ordinary-claim
  fencing, source closure, and wrapper heartbeats failing to revive expired reception.
- Go build, vet and full test suite: passed; receiver/broker race checks passed.
- Frontend check: 840 tests passed; admin and portal production builds passed.
- `localhost/codex-orchestrator:receiver-review` image rebuilt in Docker format,
  with its non-root user and healthcheck retained; it was not deployed.
- `cxx agent doctor --json` outside a managed session returns valid local registry
  JSON. An older broker reports unavailable and exits nonzero rather than pretending
  it supports the new receiver endpoint.

## Boundaries

The native canary isolates delivery from the production control plane; the real
MySQL/API tests verify that plane separately. It grants only the fixture receipt
tools and accepts only its own temporary-directory/channel confirmations. Production
native permission policies remain unchanged and may block receipt tools; a blocked
receipt cannot yield verified readiness. Claude's custom Channel confirmation and
organization policy still apply. Both native integration APIs are experimental.

A model receipt proves reception/response, not successful completion of arbitrary
work. Ambiguous accepted work is not automatically resubmitted. Re-run the canary
when upgrading either CLI; the commands are documented in [OVERVIEW.md](OVERVIEW.md).
