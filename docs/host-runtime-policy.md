# Host runtime policy: what may run on a host, and when

Status: authoritative operator decision (Chris, 2026-10-14). Applies from cxx
0.9.82 and the matching API. Code that contradicts this document is a bug.

## The rule

| Host kind | What runs without a live agent | Cron | Remote wake / remote start |
| --- | --- | --- | --- |
| **Normal** | Nothing. | None. | **Never.** |
| **Auto-update** | Nothing, except the nightly update run. | One nightly `cxx cron run`. | **Never.** |
| **Persistent** | The host daemon and its relay. | Only if also auto-update (nightly). | **Yes**, the only place it exists. |

### Normal host: a tool

- The wrappers (`cdx`, `clx`, `cgx`, `cxx`, the native `codex`/`claude`/`grok`
  shims) do their maintenance when the user runs them: update check, content and
  credential sync, housekeeping. Nothing is scheduled.
- While a native agent session runs, its own wrapper, communicator owner and
  receiver run. When the last session ends, every cxx process exits: the
  communicator owner idles out (5 minutes after its last client), and no worker,
  relay, daemon or cron job remains.
- **Dead agents do not come back.** A message, schedule delivery or watchdog
  recovery aimed at an agent whose session has ended is not executed on this
  host. It waits at most its normal TTL (24 hours) for the agent to be started
  again by a human, then expires. "Tool offline" is the intended, normal state.
- There is no per-user background worker (`cxx agent worker`,
  `cxx-agent.service`) on a normal host. A legacy unit is disabled, stopped and
  removed.

### Auto-update host

- Exactly the normal-host rule, plus one crontab line (`# cxx-managed-cron`)
  that runs `cxx cron run --due` once per night, at a stable per-host minute
  between 02:00 and 04:59 local time.
- "Auto-update" is the host's effective auto-update setting: the per-host
  override when set, otherwise the fleet default. It reaches the host as
  `wrapper.auto_update` in the signed config.
- The nightly run updates and synchronises, then exits. It never starts a worker
  or a relay.

### Persistent host: the only exception

- Persistent means the host daemon setting `resident_enabled` is true, or remote
  starts (`enabled`) are on and not expired (`daemonResident()` in
  `api/src/services/host-daemon/policy.ts`). It is set explicitly per host in the
  admin console; nothing else implies it.
- Persistence belongs to the daemon's account (`host_daemons.settings.username`):
  only that OS user may run a per-user relay or have dormant agents resumed.
  Another user on the same host is a normal user.
- Only here may processes keep running without an agent: the host daemon
  (`cxx-daemon.service`) and the per-user relay worker. Only here are dormant
  agents resumed for peer messages, persistent Wake/Cron schedules and watchdog
  recovery, and only here can sessions be started remotely.
- Remote wake and remote start are a security-relevant capability. They must
  never be reachable on a host without this flag.

## Enforcement

The server is the enforcement point; the wrapper follows it.

- **Relay registration and use** (`/host/agent-relays/*`): a per-user
  (non-daemon) relay is admitted only for a persistent host. A non-persistent
  host is answered `503 agent_messaging_relay_not_persistent` on register,
  heartbeat and claim, so a worker that still runs gets nothing to execute and
  older wrappers back off instead of retrying fast. The daemon relay keeps its
  own existing check (remote starts accepting).
- **Persistent schedules**: creating or enabling a persistent Wake/Cron schedule
  for an agent on a non-persistent host is refused
  (`schedule_host_not_persistent`). An existing persistent schedule whose host
  is no longer persistent is blocked with the same code when it falls due,
  without queuing a delivery. Ordinary schedules still reach a live receiver
  only.
- **Wrapper**: `cxx agent service install` (run by maintenance and installers)
  installs the worker unit only on a persistent host and otherwise retires it.
  The maintenance crontab line exists only on auto-update hosts, scheduled
  nightly; elsewhere it is removed.
- **Worker self-gate**: `cxx agent worker` itself asks the server whether the
  host is persistent before it watches, leases or relays anything, exits
  cleanly if not, waits (relaying nothing) while the answer is unknown, and
  re-checks every 5 minutes. This holds even against an API that does not yet
  refuse relays. A signed config that stays unreadable (permission denied, e.g.
  after the move to a root-owned layout) or expired for 5 minutes ends the
  worker with exit 0, so `Restart=on-failure` leaves it down; maintenance starts
  it again once a usable config is back on a persistent host.
- **Other accounts' legacy workers**: when root runs `cxx agent service install`
  (cron run, `cxx update`) and the server answered, it also retires every other
  account's `cxx agent worker --foreground` process (SIGTERM, a clean exit) and
  its cxx-written `~/.config/systemd/user/cxx-agent.service` plus
  `default.target.wants` link — on a non-persistent host for every non-root
  account, on a persistent host for every account except the daemon user. An
  unanswered check, or a daemon user missing from `/etc/passwd`, changes
  nothing.

## What this replaced, and why it was a fatal flaw

Until 0.9.81, `cxx cron run` installed and started an always-on per-user worker
(`cxx-agent.service`, with lingering) on nearly every host and ran maintenance
every 15 minutes. The worker registered a relay and, for any delivery aimed at
an offline agent of its host and user, started the native CLI headless and ran
the prompt. Every host therefore accepted remote execution, not only persistent
ones. As a side effect its process-lifetime communicator lease kept every owner
and control WebSocket alive: on 2026-10-14, 34 of 36 hosts with a live relay had
no native session at all. A first 0.9.82 attempt that kept this capability but
made it on-demand was withdrawn unreleased for the same reason.

## Acceptance

1. Normal host, no session: after maintenance, no `cxx agent worker`, no
   `cxx-agent.service`, no `# cxx-managed-cron` line; no communicator owner more
   than 5 minutes after the last command.
2. Normal host with a running agent: the agent works and receives live messages;
   after it ends, nothing remains after the owner's idle period.
3. A message to an ended agent on a normal host is never executed there; it
   expires after its TTL.
4. Auto-update host: exactly one nightly maintenance line; no worker.
5. Persistent host: daemon and relay run without agents; dormant agents are
   resumed; remote starts work.
6. A non-persistent host's relay registration/heartbeat/claim is refused with
   503 and the relay executes nothing.
7. A persistent schedule targeting a non-persistent host is refused at creation.
