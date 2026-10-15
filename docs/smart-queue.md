# Smart queue delivery v1

cxx 0.9.87 negotiates `queue_delivery_v1` for Codex, Claude and Grok native
receivers. This changes presentation and reception while accepted work is held;
it does not grant permission, complete work, or merge execution identities.
Older wrappers and relays retain full-message FIFO delivery. The registration
response also advertises `queue_policy_v1` independently of activation, so a
sender outside the allowlist can classify coordination for a canary recipient.
A negotiated older server receives its original request shape.

| Class | Presentation | Explicit coalescing |
| --- | --- | --- |
| `information` (default) | Catch-up preview when two are pending or one is at least 60 seconds old | No |
| `progress` | Catch-up preview | Same sender, recipient, class and `coalesce_key` |
| `notice` | Catch-up preview | Same sender, recipient, class and `coalesce_key` |
| `coordination` | Full text, ahead of catch-up | Never |

Use coordination for questions, approvals, clarifications and cancellation
notices. Class is explicit metadata, not a content classifier. Unmarked messages
remain information. Calls, conferences, explicit task results and operator portal
messages retain full text. Each sender retains ordering within its delivery lane.
An accepted work claim can coexist with one informational/coordination delivery;
no second work request starts until the existing work ends. Native queues still
wait for an idle turn. Claude retains its existing channel/turn-boundary handling.

## Sender interface

`agent_send` and `agent_reply` accept optional `delivery_class`, `coalesce_key`
(up to 128 characters), and `related_work_id` (a work message targeting the same
recipient). These fields are included in the sender/client-UUID conflict check.
Use a new client UUID for a new event and preserve it on transport retries.
Work requests reject condensation metadata. Explicit task-result replies always
use the full coordination lane.

For a progress stream, use a key such as `build:<work UUID>:compile`. For repeated
automatic notices, use `watchdog:<watchdog UUID>:capacity` or
`schedule:<schedule UUID>:late`. Only pending, never leased/accepted, events are
coalesced. Related-work references must also match, and keys are case-sensitive.
Latest text wins; the event count and first/last timestamps survive,
and previous encrypted messages remain in history as `superseded`.

Actual schedule wakes and watchdog recovery attempts are durable work, not
notices. Their run/claim/recovery IDs and existing missed-tick coalescing are
preserved. This feature counts explicit repeated notices; it does not invent a
wake execution or count receiver polls as events.

## Catch-up and original retrieval

A digest has a stable message UUID and records durable membership in the same
transaction as claiming. It contains at most 20 entries and 8192 UTF-8 bytes.
Each entry includes sender, original UUID, creation time, age, a preview of at most
240 Unicode code points, event count, and first/last event times. `remaining`
counts eligible messages beyond this digest; subsequent turns drain them.

`agent_digest_get({digest_id, after: 0, limit: 20})` returns retained original
messages and `next_after` for the next page. Coalesced originals are included.
`agent_message_get` retrieves one original by UUID. Recipient authentication,
host/engine policy and binding gates apply as for ordinary message retrieval.

Handle a digest with `agent_listen`, without sending an acknowledgement reply.
Completing its presentation marks members `digested` with `presented_at`; it
never sets their `completed_at`, claims them as work, or asserts they were read.
A substantive answer may refer to an original message. The dashboard links the
digest and its retained originals; reveals remain explicit, permission-gated and
audited.

With the capability active, `agent_listen` returns `automatic`, `held_work` and
`coordination_reception: true` while accepted work remains held. Yield once to
receive coordination at the next available native turn. Finish the work only
with `agent_task_result` or `agent_reply` plus an explicit task result. Legacy
receivers still return `work_held`.

## Deployment and rollback

Migration 0068 adds presentation metadata and indexes without changing existing
message bodies, UUIDs or work outcomes. It is idempotent and applied by the usual
migration runner, not manual SQL.

The server defaults to disabled:

```
CXX_QUEUE_DELIVERY_V1_ENABLED=false
CXX_QUEUE_DELIVERY_V1_HOST_IDS=
```

For a canary, enable the flag with a comma-separated host-ID allowlist, for
example `CXX_QUEUE_DELIVERY_V1_HOST_IDS=257`, and recreate the API through the
normal deploy workflow. Empty allowlist means all capable hosts when enabled.
Verify the registration response capability, seven stale updates in one digest,
retrievable original bodies, a full approval while work is accepted, and no
second task admission. Exercise Codex, Claude and Grok before expanding the list.
Measure queue age and drain turns alongside request errors/lock waits; transport
success alone is insufficient.

Disable the flag and recreate the API to roll back presentation. Heartbeats
withdraw the capability; reenabling requires a new receiver registration.
Certainly unpresented queued digests restore their uncanceled, unexpired
originals. Existing leased presentations remain fenced until their receipt or
expiry. Accepted/ambiguous digests never replay originals automatically, since
those previews may already be in the native transcript. Original retrieval and
explicit work-result paths remain available. Retain migration 0068 on rollback;
do not drop metadata while an updated receiver or digest exists. Disable the
flag on the updated server as the supported rollback; drain pending presentations
before replacing it with an API build predating migration 0068.
