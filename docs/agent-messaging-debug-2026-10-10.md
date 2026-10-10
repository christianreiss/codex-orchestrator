# Inter-Agent communication investigation — 2026-10-10

Owner: Emma, agent:f9b1e32b-58b7-4ad2-b8ff-6cde95086cf7.
Baseline: main 2c3b3d4e1027302a2b50d40f1f293eb837410b05, clean worktree.
No matching CoCo project exists; project bootstrap returned Project not found and project discovery confirmed no orchestrator project.

## All running peers interviewed

At 06:06–06:07 UTC, presence-based discovery returned five running peers, all Codex on biest.eulie.de. Resumable historical addresses were not counted as running.

| Peer | Canonical agent UUID | Evidence |
| --- | --- | --- |
| Simone (Blender Master) | 23d95212-1c3f-4bb8-a720-236e94a229ec | Bus interview 1cd6cd53-e651-4c10-9ad1-d29a19fb7650 remained queued/attempts 0. One diagnostic native queue submission reached her; she replied with current ready doctor versus receiver_unavailable listen, four same-session MCP processes and historical 36m25s acceptance delay. |
| Marianna (Advisor Master) | 03c70b0a-d9b4-4dc2-9580-6593536a37e1 | Bus interview 9de25cf0-15c6-4a63-a35b-67498ced0857 remained queued. One diagnostic native queue submission reached her; she confirmed Portal afbc5599-b9ad-4cd3-a0be-e56bc32e5ac3 rejected with portal delivery is not owned by this receiver, three same-session MCP processes, and receiver_unavailable listen. |
| Erna (Script Master) | 2c2ad9db-b47b-49b1-8d1e-4413616005d2 | Reply 2773ab26-9bc0-4250-89e3-923f993cc263; interview accepted within two seconds. Request 2b494f56-1e64-4055-abca-c8e175cd74a5 to Simone still queued/attempts 0 after 85 minutes. Historical accepted_lease_lost work had actually delivered assets and must not be replayed blindly. |
| Traudel (Render Master) | f88d5c07-1d53-4d37-b21e-463cf2c41199 | Reply 6550af2f-ab0f-4fcc-8625-31ca5e94f3a9; timely automatic receipt, working schedules. Correctly rejected task_result on an ordinary message. |
| Loretta (Render Cockpit) | 6053fa13-80ee-4761-bb8d-0977ee5be56e | Reply cb238bc9-527c-42f6-b1a5-3a236a03c0e6; timely automatic receipt, historical peer delays and claim-required errors. Correctly rejected task_result on ordinary interview message. |

Simone/Marianna diagnostic answers were sent to Emma through agent_send and inspected in their native transcript's completed MCP tool records because Emma's active turn intentionally delays automatic intake. This is distinct from claiming the waiting originals. No film/render task, native session, provider account or production service was restarted or replayed.

## Cause and repair

Native subagents inherit the launch broker/session/socket. Each MCP process creates its own autoReceiver and channelTracker. The server already fences fresh competing receiver registrations (receiver_owned), but model tools can run in another MCP process: that instance reports its own disconnected health, cannot finish the owner's peer claims and rejects the owner's pending Portal delivery. Both affected launches had several direct app-server MCP children with identical selected session/socket environment values. All were old deleted executables after prior wrapper replacement. Exact PID-to-subagent mapping and the cause of every historical delay remain unproven.

Wrapper 0.9.44 elects one session-local automatic receiver through a file lease and mode-0600 Unix socket beside the existing private broker. Sibling MCP instances forward tools/call to the elected owner and therefore use the same health, claims and Portal receipts. Tests reproduce the split ownership error and prove shared reply/status/listen, single-owner election, handover and no mutation retry. No extra network listener is added. The path is engine-independent for Codex, Claude and Grok.

A separate live discovery invocation with limit=100 returned server_error/HTTP 500 instead of reporting the documented maximum of 50. Route Zod errors now return HTTP 422 validation_failed in each response envelope; ordinary internal errors remain 500.

Task result rejection on kind=message is intentional. The operator manual clarifies that formal results require agent_request, conference task or schedule deliveries; ordinary messages receive text replies.

## Verification and rollout boundary

Go build/vet and tests across agentbus, agentportal, Codex, Claude and Grok passed. Race tests for agentbus/agentportal passed. API HTTP tests: 14 files/90 tests passed. API typecheck/lint/build passed; lint retains 114 existing warnings, no errors. Targeted final checks and native/release evidence are recorded separately below.

Existing processes require a coordinated MCP reload after updating: mixed old/new processes cannot share this ownership state. Accepted work must not be auto-replayed to compensate for old receipt loss. A successor can acquire the local owner lease, but process-local receipts are not persisted across owner death; inspect retained server state. This is a communication fix, not exactly-once external-effect delivery.

The operator explicitly authorized the complete fix including commit, push, production rollout and affected MCP repair on 2026-10-10 ("Das beinhaltet alles. Do"). Rollout is proceeding to docker01.uggs.io; live verification is recorded below once complete.

### Final executed evidence

- Final targeted envelope suite, API typecheck and targeted lint passed after the final validation edit.
- Final shared-receiver regression tests passed under the race detector.
- All four Linux/macOS amd64/arm64 release packages built under `/tmp/cxx-inter-agent-release/`. Linux amd64 SHA-256: `1c750b6c64ace4dff830d6da4365c01f0dbfacd38e82f6c3421a85649a51607a`.
- Codex 0.162.1 native canary passed using the development binary: exact peer and Portal replies, both after forced generation reconnect, offline broker reported unavailable.
- Packaged Linux amd64 native canary also passed with a second MCP subprocess sharing the owner: native session `01a12476-6d1c-7bb2-b960-501da3d1c6ee`, final generation `98e18eca-cc6f-47b4-a755-b4035d395767`, `sibling_shared_receiver:true`, peer/Portal correlated replies before/after reconnect and offline-state check.
- The historical native-canary mock initially rejected `self`, then watchdog `get`; its fixtures now cover identity, explicit Portal read/working events and the absent watchdog. Neither failure established a product regression. The optional `--sibling-mcp` exercises shared ownership without permitting shell/file tools.
- Evidence logs: `/tmp/inter-agent-fix-go-tests.log`, `/tmp/inter-agent-fix-race.log`, `/tmp/inter-agent-fix-api-http.log`, `/tmp/inter-agent-fix-api-lint.log`, `/tmp/inter-agent-fix-api-build.log`, `/tmp/inter-agent-fix-api-envelope-final.log`, `/tmp/inter-agent-fix-codex-canary.log`, `/tmp/inter-agent-fix-codex-shared-canary.log`, `/tmp/inter-agent-fix-release.log`.
- Native execution covered Codex on Linux. Claude/Grok shared wrapper paths were covered by Go tests; macOS/arm64 were cross-built only. No DB migration, production DB test, production rollout or native session restart was performed.

The two still-queued original interview conversations with Simone/Marianna were canceled after their direct diagnostic answers, to avoid duplicate interview work after recovery. No project task or peer work was canceled.
