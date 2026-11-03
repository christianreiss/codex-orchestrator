# Cooperative job memory admission

On Linux, submit a heavy local command through the shared wrapper:

```sh
cxx workload run --memory 8GiB --wait 5m -- cargo build --release
cxx workload status
cxx workload hold
cxx workload resume
```

`cdx workload`, `clx workload` and `cgx workload` use the same implementation and
reservation pool. These commands work without fleet configuration, auth, MCP or
a running communicator. They do not start a model or alter running native agents.

`--memory` is the caller's estimate of the job's peak RAM, including children;
positive whole `B`, `KiB`, `MiB` and `GiB` values are accepted. No memory cap is
installed: underestimating a job can still exhaust the host. Commands launched
outside this entrypoint, other Unix users, remote jobs, and work started through
systemd, Docker or a VM manager are outside its accounting. This is cooperative
admission, not universal command interception or a guarantee against OOM.

Admission serializes reservations across this Unix user's projects and engines.
It reads current `MemAvailable` and the process's cgroup v2 memory limit/current
usage at every visible ancestor. Missing, invalid or unsupported constraints fail
closed; cgroup v1 memory accounting and non-Linux execution are unsupported.
Free swap is diagnostic only and never increases the admitted RAM budget.

The available amount is reduced by every outstanding declared reservation and a
system reserve: by default 10% of effective RAM capacity, at least 256 MiB.
`--reserve 2GiB` explicitly replaces that reserve for this request. Already
allocated job memory remains included in its reservation, so the calculation is
deliberately conservative. Jobs can use every CPU core; the launcher lowers only
the submitted job's priority to nice 10, retaining an already lower priority.
It installs no memory, swap, task/thread or CPU limits and never kills jobs in
response to pressure.

By default, insufficient RAM or an active hold refuses the command without
starting it. Metadata-lock contention is bounded to 250 ms. `--wait` permits
retrying admission until that duration expires; Ctrl-C/TERM/HUP cancels waiting.
An admission timeout does not become a job runtime timeout. Once started, actual
user signals are forwarded to the job's process group; memory pressure never
terminates it. The direct command's exit code is preserved. Avoid using this
launcher for interactive terminal programs requiring foreground job control.

The launcher becomes a Linux child subreaper. It keeps the reservation until
the direct command and its orphaned descendants finish, including ordinary
double forks and `setsid` children. A launch barrier publishes the job identity
before the command may execute. Manager-mediated jobs remain outside this
process tree; memory requirements for those need a separate adapter.

Reservations and the durable new-job hold live in the private directory
`/tmp/cxx-workload-<uid>`; the path cannot be changed by environment variables.
Do not remove that directory while jobs run. The pool is per user and shared
filesystem view, not a security boundary against deliberate same-user bypass.
`hold` blocks future admission, including queued requests, and leaves admitted
jobs and native agents running. `resume` clears only that hold.

After a wrapper crash, a launched reservation remains **uncertain**, even when
its original process group disappeared, because detached descendants might
still exist. `status` lists IDs, bytes and uncertainty. After independently
verifying **every** descendant and externally launched job has ended, reconcile:

```sh
cxx workload release RESERVATION_UUID --confirm-finished
```

Release refuses while the recorded wrapper or process group is still live. The
confirmation remains the caller's responsibility for escaped processes. Pending
launches whose wrapper died before the barrier and records from a prior system
boot are safely reclaimed automatically. Corrupt state refuses new admission
rather than inventing free capacity. A hold survives wrapper restarts and remains
until `resume` (or removal of the temporary filesystem on system reboot).
