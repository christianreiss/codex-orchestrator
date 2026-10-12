# Planned host reboot and one-use resume

Linux hosts can transfer their current Codex, Claude or Grok task across a planned
reboot. cxx owns the boot hook; no permanent reboot daemon is required. The agent
needs operator authorization for the reboot and root or passwordless sudo. An
active `cron.service` or `crond.service` and systemd reboot support are required.

```sh
cxx reboot --request-id 6d260949-01bf-42da-b9a9-f3843a7ad787 \
  --reason 'Activate the installed kernel' --stdin <<'CHECKPOINT'
The kernel installation is complete. After boot verify uname and service health,
then finish the existing task with its original message IDs. Do not reinstall or reboot.
CHECKPOINT
cxx reboot status
cxx reboot status --id 6d260949-01bf-42da-b9a9-f3843a7ad787
cxx reboot disarm --id 6d260949-01bf-42da-b9a9-f3843a7ad787
```

The session-scoped MCP equivalents are `agent_reboot` (`request_id`, `reason`,
`continuation`) and `agent_reboot_status`. `cdx reboot`, `clx reboot` and `cgx reboot`
use the same implementation. Darwin returns an unsupported-platform error.

The checkpoint describes completed effects, pending verification and original work
message IDs. It is limited to 32 KiB. Retrying the same UUID with identical input is
idempotent; a different body is rejected. There is exactly one pending job per host.
Watchdog or enabled persistent Wake recovery for that address blocks preparation;
preparing a reboot also prevents enabling competing recovery. Ordinary scheduled
work remains supported and an accepted Wake keeps its original execution.

## Ordering and persistence

1. Confirm the authenticated launch, native UUID and recovery policy, then reserve
   the host in `agent_reboot_handoffs`. Continuation text is encrypted server-side.
2. Freeze the executing cxx under the root-owned
   `/usr/local/libexec/cxx-reboot-resume/<request-id>/cxx`. Atomically write and sync
   the mode-0600 journal in `/var/lib/cxx/reboot-resume/<request-id>.json` and the
   single owned `/etc/cron.d/cxx-reboot-resume` entry.
3. Arm the server handoff. Accepted Peer/Wake and current Portal instructions are
   held as `reboot_hold`. Their original IDs and claims are retained. Further
   delivery to the old session waits. Related daemon operations are also held.
4. Persist local issuance before calling `systemctl reboot --no-block` once.
5. At boot acquire the host lock and compare kernel boot UUIDs. On a new boot,
   persist `consumed`, remove the owned cron entry and sync its directory, then
   launch under the original UID, groups, HOME and cwd. Same-boot calls do nothing.
6. Wait at most five minutes for signed configuration/control-plane readiness,
   verify the native transcript and acquire its writer lock. Start one native
   resume with the exact saved ID through normal cxx auth and launch policy.
   An IP-binding mismatch during early network startup is retried only within
   this readiness deadline: IPv6 may be online before the bound IPv4 route.
   Invalid credentials and other permanent policy failures still stop immediately.
7. Registration atomically fences the old launch token, retains the agent UUID,
   assigns the new launch identity and transfers work to its new receiver. Lost
   registration responses replay the same new session ID. The receiver restores
   receipt correlation without injecting the original task a second time.

A resumed agent calls `agent_self` and `agent_reboot_status`, verifies the reboot
and continues the checkpoint. Peer and Wake results still require explicit
`agent_task_result`/`agent_reply`; Portal replies retain their original message ID.
The wrapper emits no successful work result merely because the process exits zero.
Daemon continuation results use an explicit structured task report when supplied;
otherwise their outcome remains unknown. Remote stop is observed by the continuation
supervisor and stops only its own child process group.

Active Clients displays the reboot state and links the old and new launches.
The previous Portal history stays with the previous launch. The current accepted
instruction and its reply live with the continuation. Native history stays in the
same provider transcript.

## Interactive continuation with tmux (cxx 0.9.63)

After consuming the boot job, cxx checks for an executable `tmux` in the restored
PATH **as the original user**. If available, the continuation runs interactively
in a detached session named `cxx-reboot-<request-id>`. Each request uses its own
config-free tmux server with the same name as its socket label, so existing tmux
servers and their environment/settings do not influence the continuation.
No tmux installation is attempted. Without tmux, the existing headless path runs.

Read `cxx reboot status --id UUID` for `execution_mode` (`tmux` or `headless`),
`tmux_session` and `attach_command`. Run the reported command as the original user:

```sh
tmux -L cxx-reboot-UUID attach -t cxx-reboot-UUID
```

Codex, Claude and Grok resume their exact saved native UUID with the checkpoint
as one initial prompt. stdin/stdout/stderr remain connected to the pane's terminal.
The checkpoint is handled automatically; the CLI then stays available for operator
input. Detach with `Ctrl-b d`; detaching does not finish or stop the continuation.
Exit the provider CLI normally when finished. The boot process keeps the journal
running until the supervisor completes, and removes only its own session afterward.
The supervisor observes remote stop and terminates its own native process group,
including descendants, without stopping other tmux sessions.

Terminal output is streamed to the existing private reboot log through tmux's
pane logging. It is never parsed as a structured task report. Transferred Peer,
Wake and Portal instructions still require their explicit receipts; unreported
work remains unknown/ambiguous even if the CLI exits successfully. For a daemon
continuation without a separate explicit report, the overall work outcome remains
unknown. Local process completion and task success are different facts.

A tmux setup failure, a killed pane/server or a missing supervisor result fails
this continuation. It never falls back to a second native launch. Private handoff,
gate and completion files exist only for this run and are removed afterward;
the root-owned boot journal, frozen executable and diagnostic log remain.
A pre-existing session with the same request name is never replaced or stopped.

## Failure and manual recovery

Consumption is deliberately **at most once**. A crash after consumption and before
exec loses the automatic continuation. Cron unlink failure, missing transcript,
changed identity, cancellation, denied auth, busy writer or startup failure never
creates a fresh session and never retries native execution. The consumed native
UUID is a permanent rearm guard, even under a different request ID. Journal rows
and frozen binaries are retained for diagnosis.

Use `cxx reboot status --id UUID` and the private
`/var/lib/cxx/reboot-resume/UUID.log` for local evidence; MCP status reports the
server handoff. Disarm removes an unconsumed hook and ends the server reservation.
It cannot cancel an OS reboot already submitted. Unclaimed server handoffs expire
after 24 hours; held work becomes ambiguous, never queued again or successful.
A local failure before server contact may leave server status awaiting reboot
until expiry; local journal state is the evidence for whether startup was consumed.
After inspection an operator may explicitly resume the same native transcript
manually. Automatic recovery never deletes its loop guard.

The boot journal contains no old bridge token or provider auth copy. It saves only
identity, checkpoint, user/workdir and selected nonsecret path/locale settings.
Normal signed fleet credentials are loaded again as the original user.
Grok saves the managed runtime's durable base home, not its disposable access-only
auth projection. A pre-0.9.56 Grok launch must be restarted through an updated
wrapper before it can prepare this handoff.

## VM acceptance (2026-10-11)

Tested on the operator's Debian 13 VM `10.2.0.204`, as `reboottest` (UID 1000)
in `/home/reboottest/reboot-test`, with the cxx 0.9.56 candidate. Each engine
issued a real reboot through `agent_reboot`, then automatically continued and
exclusively wrote/fsynced its after-proof. Independent comparison confirmed the
same native UUID and agent address, a new launch and kernel boot UUID, unchanged
user/workdir, and removal of the cron entry before native startup.

| Engine / native CLI | Preserved native session | Result |
| --- | --- | --- |
| Codex 0.162.1 | `01a12a7c-67ce-7163-bf40-b387f6a08aa4` | Passed |
| Claude 2.1.296 | `08de09d4-af31-4d9d-b825-d72c0c69e7cd` | Passed |
| Grok 1.0.46 | `01a12a7f-c351-7872-89ba-dfa70d0bb72a` | Passed |

A further unarmed reboot (`02748dfc…` → `cf67ebbd…`) left all five journals
and three after-proofs byte-identical. No boot hook, native provider process or
new test-host launch appeared. Frozen binaries also ship their relative persona
aliases so an unprivileged continuation need not repair the root-owned layout.

Fresh headless launches without a native binding were rejected before arming.
The real boot test exposed an early IPv6/IPv4 readiness race; the first two
attempts stopped without retrying native execution. Their journals were retained,
their server reservations manually disarmed, and subsequent tests used separate
native sessions. The final readiness fix preserves strict IP binding.

Source verification includes full Go tests/build/vet and targeted race tests,
API unit/contract coverage, MySQL integration for original Peer/Wake/Portal
claims and daemon continuity, frontend checks, and Active Clients browser tests.
The VM proves provider resume and host lifecycle; transferred work receipts were
verified by integration tests, not by the direct-prompt VM runs.
