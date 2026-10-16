# Historical reports

These reports preserve revision-specific findings, test evidence and delivery
limits. Archiving does not assert that every finding is fixed. Versions, host
state, commands and rollout instructions describe their original investigation;
use the [current documentation](../README.md) and verify runtime state before
acting on them.

## Security and engine integration

- [2026-08-17 remediation status](AUDIT_2026-08-17_remediation.md): completed work
  and outstanding phases from the external reviews.
- [2026-10-12 engine maintenance](engine-maintenance-2026-10-12.md): native CLI
  versions, model and configuration decisions, verification and delivery ledger.
- [2026-10-15 gateway acceptance](gateway-matrix-2026-10-15.md): nine surface/backend
  combinations, with a linked machine-readable receipt.

## Messaging and receivers

- [Messaging review, 2026-10-07](agent-messaging-2026.md).
- [Messaging lifecycle audit, 2026-10-08](agent-messaging-audit-2026-10-08.md).
- [Communication investigation, 2026-10-10](agent-messaging-debug-2026-10-10.md).
- [Execution contract v2 rollout and rollback](agent-execution-rollout.md).
- [Receiver verification through 2026-10-08](receiver-verification.md).
- [Grok MCP verification, 2026-10-08](grok-mcp-verification.md).
- [Grok tool diagnostics, 2026-10-08](grok-tool-diagnostics-2026-10-08.md).

## Communicator and startup performance

- [Communicator audit, 2026-10-13](communicator-audit-elvira-2026-10-13.md).
- [Fleet-count database acceptance, 2026-10-13](communicator-fleetcounts-elvira-2026-10-13.md).
- [Actual native startup comparison, 2026-10-13](communicator-startup-native-elvira-2026-10-13.md).
- [Healthy-startup profile, 2026-10-13](communicator-startup-profile-claudine-2026-10-13.md).
- [Wrapper startup measurements, 2026-10-15](startup-performance-2026-10-15.md).

The [bug audit](../bug-audit/2026-10-11-triage.md),
[residency verification](../verification/communicator-residency-2026-10-14.md)
and [gateway receipt](../evidence/gateway-matrix-2026-10-15.json) retain their
existing dedicated locations.

The obsolete `admin-ui-redesign-brief.md` and `redesign-discovery.md` were removed
on 2026-10-16: they prescribe the retired PHP/vanilla-JS console and direct edits
to its old CSS assets. Their contents remain recoverable from Git history.
The maintained replacement is the [Svelte console contract](../admin-ui-design-spec.md).
