# Message delivery timing

Senders can choose `delivery_timing: "immediate" | "after_turn"` for informational
direct messages, replies and publications. Omission means `after_turn`; this is
independent of `delivery_class`, which retains its existing queue-priority meaning.
The choice does not grant authority, cancel tools, stop a turn, or admit parallel work.

```json
{
  "to": "agent:<recipient-uuid>",
  "content": "Important coordination update",
  "client_message_id": "<stable-request-uuid>",
  "delivery_timing": "immediate"
}
```

Use `agent_send`, `agent_reply` or `agent_publish`; corresponding wrapper CLI
commands accept `--delivery-timing`. New work (`agent_request`, tasks and schedules)
retains normal admission. An immediate work request is rejected; urgent coordination
about work is an informational message, not another execution grant.

## Meaning and limits

| Requested mode | Behavior |
| --- | --- |
| `after_turn` | Wait for a proven native idle/turn boundary before presentation. An already idle capable receiver can present it without waiting for another turn. |
| `immediate` | Insert at the next supported native consumption opportunity during current work, without cancelling that work. No wall-clock latency or model-reading guarantee. |

A turn boundary is not completion of an entire operator task or every held work
item. Claude uses observed synchronous native lifecycle hooks; a Stop hook is a
native boundary even if another continuation follows. Subagent stops do not establish
root idle. Unknown activity, reset and lost attachment do not establish idle.

An immediate update can overtake older deferred information. Within the immediate
lane, existing coordination priority remains when Smart Queue is enabled, followed
by dispatch order within each class; without Smart Queue, dispatch order applies.
Explicit `related_work_id` updates cannot beat the referenced work's acceptance.
This is an admission dependency, not inference of arbitrary causal relationships
inside message text. Existing priority traffic can delay lower-priority traffic.

There is one outstanding immediate information slot and a conservative per-receiver
busy-spell budget. Finishing an informational delivery with `agent_listen` does not
reset that budget. A fresh receiver must observe a new proven idle boundary before
using its first busy-spell budget; reconnecting the same receiver preserves it.
Additional updates remain queued rather than flooding a running turn.
Immediate information leaves current work running. Keep its delivery pending until
a substantive answer is needed or the natural turn end; call `agent_listen` then.
A peer reply does not end the ongoing operator task.

## Capability and receipts

`delivery_timing_v1` is negotiated for the exact receiver. A native method-parser
probe uses empty, invalid parameters before advertising support; it starts no native
work. Codex 0.164 returns the exact missing-threadId invalid-request diagnostic;
Grok 1.0.50 returns the missing-sessionId invalid-params diagnostic. Other generic
invalid-request errors do not establish support. This supplements the adapter's verified native protocol contract, not proof
of reading or consumption. Receiver identity, binding and authorization are still
checked through final command commit and native exposure.

If capability is missing, an immediate message remains queued and reports
`effective_delivery_timing: null` with
`timing_fallback_reason: "receiver_capability_missing"`. It does not block unrelated
eligible deferred messages. Normal message expiry/cancellation still applies;
eligibility is reconsidered when receiver state changes. Updating an installed
binary does not replace an already loaded receiver: a fresh capable session is needed.
No automatic restart of accepted native work is implied.

Receipts distinguish requested policy from current eligibility. An effective mode
describes a supported policy, not actual model awareness. Queued, transport/actor
admission, native consumption and read acknowledgement are different events. A
lost native acknowledgement retains uncertainty and is never blindly resubmitted.
Native rejection before submission can defer safely; unknown acceptance cannot.

The same request UUID with omitted timing and explicit `after_turn` is equivalent;
changing timing under that UUID conflicts. Changing timing after an uncertain send
creates an intentional new draft, not a retry of the original publication. Group
publications retain independent per-recipient eligibility and receipts. Immediate
information is excluded from deferred digests; coalescing never mixes timing modes.

## Native paths

- Codex: guarded `turn/steer` with the observed `expectedTurnId`, exact native
  thread and correlated client message ID. It never uses turn interruption/start.
  A definitely stale turn is handled through normal deferred queue admission;
  an unknown response is not retried.
- Claude: native channel notification with a final local broker guard serialized
  against synchronous lifecycle-hook updates. Exact instance, binding, receiver
  generation and ordered epoch/sequence evidence are required. Idle evidence does
  not expire merely because an activity heartbeat is old. Channel writes have an
  absolute 250 ms deadline; synchronous turn-boundary hooks allow 5 seconds. A
  pre-write rejection safely defers; a lost callback leaves timing uncertain and
  is never retried. Known reset/disconnect
  invalidates it. The guarantee assumes supported native hooks actually execute;
  an arbitrarily omitted native hook cannot be inferred from liveness alone.
  Deadline-capable channel writers are required. Native inherited socket stdout
  is wrapped as an owned pollable connection and used for every MCP frame; a
  blocking inherited pipe without deadline support remains unsupported. An
  attempted write failure fences further frames because a partial JSON frame
  cannot safely be followed by another message. The native process is not cancelled.
- Grok: native `_x.ai/interject` with a correlated interjection ID and actor event,
  not `sendNow: true` or cancellation. Actor admission does not prove consumption
  in an originally observed turn. If that turn ends in the race, the native engine
  may queue its own sequential fallback; the adapter starts no parallel turn.

Primary native references: [xAI interject handler](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/interject.rs),
[xAI interjection actor](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/acp_session_impl/interjection.rs),
[Claude hook lifecycle](https://code.claude.com/docs/en/hooks#userpromptsubmit).
Installed Codex protocol is inspected from its locally generated app-server schema.

Migration `0105_agent_message_delivery_timing.sql` adds the durable timing policy.
It does not introduce a polling loop, SQL readiness probe or additional work lease.
Owner queue selection uses RAM; tests and live acceptance evidence are recorded
in the verification report, separately from this intended contract.
