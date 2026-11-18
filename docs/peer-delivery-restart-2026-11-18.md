# Peer delivery across the 2026-11-18 API restart

Status: reported automatic-recovery failure remains unconfirmed. No production
code fix, additional production restart, session reset or message redrive was
performed. Baseline/release inspected: `c5bd7333d8de703021103464d084c9b95d78783e`.
All times below are UTC; local CET is one hour later.

## Report and scope

The operator reported that queued peer messages failed to arrive after an API
restart and later explained that he had asked Annegret to fetch the message.
A later successful delivery cannot establish automatic recovery after an operator
intervention. Both named agents were therefore asked directly, and their replies
were compared with production delivery metadata and the exact native transcripts.

- Uschi: `f15c6ef5-bc02-4dae-99d6-028153f08373`, Codex on `docker02.uggs.io`.
- Annegret: `9d996eab-afa1-4538-9fae-302bb5915b4a`, Claude on `biest.eulie.de`.
- Server: `docker01.uggs.io`; API container started at 08:49:25.267 during the
  already-authorized deployment. This timestamp is not API readiness.

Only scoped delivery metadata was read from production in read-only transactions;
message bodies, application exports and credentials were not queried there.

## Evidence

| UTC | Observation |
| --- | --- |
| 08:48:02–03 | Uschi's `4538a8b7-9842-48fd-a804-467e6497bbd6` was sent, accepted, and inserted into Annegret's active Claude turn. |
| 08:48:37 | Annegret explicitly replied to that message; Uschi sent `ab110e58-86bd-456e-878b-c983f02b4866` with `after_turn` timing. |
| 08:48:39–43 | Annegret's reply `c2bed6b5-5d0e-4c3d-b5b2-e4025353c2e4` was accepted and appears in Uschi's native transcript without a manual fetch. |
| 08:49:35–40 | Annegret called `agent_listen`; it returned `receiver_unavailable`, not a message body. |
| 08:49:46 | Annegret called `agent_wait`; it immediately failed with a communicator handshake HTTP 502 and returned no message. |
| 08:49:49 | Annegret's read-only communicator status still reported HTTP 502/disconnected. Running communicator version was 0.9.181, with an executable replacement to 0.9.183 reported. |
| 08:49:55–56 | Annegret's connection-owned receiver reattached at 08:49:55.650 (generation `3a47a8cc-b25a-449a-a3b6-be7173a133de`); Uschi's reattached at 08:49:56.294. Annegret's active turn ended at 08:49:56.454. |
| 08:49:57 | Uschi's reply `fcdd97d2-4c66-4920-9928-5fd3c3d4f109` was stored. Its earlier attempted call had returned HTTP 502; the exact later storage/retry trigger is not established here. |
| 08:49:58 | Digest `b7c02142-bd8a-4c8e-ba86-0d9aa25d0461`, containing `ab110e58` and `fcdd97d2`, was enqueued/dequeued as a native Claude channel event and started Annegret's next turn. |
| 08:50:08 | Annegret acted on the digest's contents. |
| 08:51:01 | Annegret called `agent_listen`; the digest was completed and its members marked presented/digested. These database timestamps are not the earlier native insertion time. |
| 08:52:30 | After the operator's instruction to check messages, Uschi retried the reply, creating a second message `9d004861-cecd-45e9-a3de-a62773b14bfc` with the same content. Annegret received it as another channel event. |

Uschi directly confirmed the operator instruction, the ambiguous HTTP 502 and
the repeated reply. Annegret reported no operator instruction to fetch in her
visible transcript; her own `agent_listen`/`agent_wait` attempts preceded the
digest and failed. This difference from the operator's account is unresolved;
neither account is silently replaced by the other.

The identified messages survived the restart and entered the native transcripts.
That rules out physical loss of these rows, not every failure of automatic
recovery. Annegret's failed manual wait did not return the digest. The later
channel event is consistent with recovery plus `after_turn` gating, but cannot
alone exclude an indirect effect of a preceding manual probe. The duplicate
reply is observed; the original message was not missing simply because its
sender had received an error instead of a successful send receipt.

The retained command receipt attributes the digest's claim
`9aa0fa4e-4769-478a-a4c4-8ad03f47fd5e` to
`session:b7af3838-30d3-4c12-a34f-7c80c605e22e`, kind `messaging.claim`, owner
epoch `ab629f4d-5a34-4b2e-a971-2a345c531b6f`, sequence 60, at
08:49:58.404. This corroborates the receiver connection and native insertion;
the receipt does not identify whether an earlier manual probe indirectly helped
reconnection. The shared communicator process was still PID 2283808, started on
2026-11-16, so that process had not been restarted by those manual probes.

## Regression coverage

`TestClaudeReceiverAutomaticallyRecoversQueuedMessageAcrossOwnerRestart` runs
the receiver's real `run` reconnect loop, closes its Unix WebSocket state stream,
simulates an HTTP 502 interval and then presents a replacement owner epoch.
The API remains unavailable until an actual native-binding/registration retry
has received HTTP 502, requiring the loop to retry again. It asserts one
presentation during the exercised run (sampled after cancellation/join), unavailable/ready transport
states, no legacy heartbeat fallback, and preservation of native/session identity
and delivery correlation. The fixture never calls `agent_listen`, `agent_wait`,
manually reconnects `connection`, or resends the message.

The initial full Agentbus suite passed 820 tests. After strengthening the new
fixture to require a failed reconnect, its two focused restart tests passed
three repetitions with the race detector (six cases). Go build and vet passed.
The first strict fixture incorrectly waited specifically for registration;
the reconnect fails earlier at native binding. The fixture now observes either
request and passed on rerun; this was a test-fixture correction, not a product fix.
The API and queue are simulated; the queue removes an item on claim, so duplicate
server redelivery is outside this coverage.
SQL rehydration, real native Claude, the negotiated timing/busy-turn path and
cross-host end-to-end recovery are not established by this test. No claim that
the complete production system passes a restart acceptance test is made.

API/frontend/full cross-engine suites were not rerun for this test-only change.
No wrapper version bump or binary publication is required by the unchanged runtime.

The older related report `86c4ccc0-3ad4-4622-afe0-dea280024011` remains a
separate unresolved observation; this investigation does not mark it fixed.
