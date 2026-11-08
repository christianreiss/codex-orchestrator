# Command output filtering with RTK

cxx manages an optional external RTK OSS binary for Codex, Claude and Grok. It filters supported development-command output before the agent reads it. It does not proxy provider traffic or change the selected model.

## Controls

Settings → Command output filtering owns fleet defaults independently for each engine. Host detail offers Inherit, Enabled and Disabled for each assigned engine. Missing policy is disabled. A host override takes precedence over the fleet default; a session disable takes precedence over both. Engine suspension still prevents launch.

After a host sync receives the signed policy, it applies to new launches. Existing sessions retain their launch policy. A configured enabled switch is not proof that a host has installed RTK or prepared its adapter. Host status distinguishes policy source, observed version, readiness, errors and observation time; old or absent reports remain unknown.

## Engine integration

All three engines use session-scoped instructions to invoke RTK explicitly.
Filtering depends on the agent following that guidance, rather than guaranteed
transparent interception. The upstream rewrite helper uses Claude permission
rules; rewriting Grok commands could change which native command restrictions
match. Codex rewrite control also requires an approval decision. cxx therefore
does not install rewrite hooks or emit approval decisions. Status reports
`instructions` mode for each engine. Native checks see the command the agent
actually asks to execute, including explicit RTK invocations.

## Data and recovery

The managed edition is RTK OSS 1.2.0, with pinned archive digests for Linux and macOS on amd64 and arm64. Downloads are verified before installation into cxx-owned storage. The API mirrors verified archives through a private disposable cache owned by its unprivileged process; it does not write into the root-owned wrapper bakery. User-installed binaries and configuration are preserved. Upstream telemetry is disabled.

Concurrent engine launches reuse the verified cache without competing for its installation lock. If installation is in progress, callers wait for it within a bounded, cancellable timeout before verifying the result.

Recall and tracking are session-local. Raw output stays on the host in private bounded storage and is removed after session teardown; abandoned storage is cleaned only once its owner has ended. Commands and output are never included in readiness reports. Read a printed recall hint within the same session to recover omitted output.

Use `--no-rtk` on a managed launch, or `RTK_DISABLED=1`, to disable filtering for that launch. `cxx rtk status --json` reports policy and installation diagnostics. `rtk bypass <command>` requests raw output for one command where RTK is available.

## Operational acceptance

Test actual native execution independently for all three engines, including failures, approvals, bypass, recall and teardown. Command output reduction is not equivalent to subscription-quota or financial savings. No savings aggregation is collected centrally.

Deploy first with fleet defaults disabled, verify the three-engine canary, then enable fleet defaults. Offline or incompatible hosts stay pending or unavailable until they converge. Roll back by disabling fleet defaults and host overrides; existing sessions keep their launch policy.
