/**
 * Fleet-wide switch for `cxx remote`, the wrapper's process API on machines the
 * fleet reaches over SSH.
 *
 * It is a fleet control, not a security boundary, and the guidance below says so
 * in the agent's own document. An agent that can run `cxx remote` can already
 * run `ssh`: the switch decides whether this fleet works that way and gives an
 * operator one place to see and change that, but it takes no reach away from
 * anyone. Anything written here that implied confinement would be a lie the
 * model would then act on.
 */
export const REMOTE_EXEC_ENABLED_KEY = 'remote_exec_enabled';

export const REMOTE_EXEC_GUIDANCE = `## Remote execution

Work on another machine over SSH goes through \`cxx remote\`, not through bare \`ssh\` calls.
One connection is established per target and reused, so a command is a channel on it rather than a
new handshake; the target needs nothing but SSH access, and this binary installs itself there on
first contact. A destination is whatever \`ssh\` accepts, so \`~/.ssh/config\` aliases work.

**A job outlives its connection.** \`cxx remote exec --host H --job build -- make -j8\` returns as
soon as the job is running, not when it finishes. Read its output from a byte cursor with
\`cxx remote read --host H --job build --from N\`, wait for it with \`cxx remote wait\`, signal it
with \`cxx remote signal\`. Every response carries the cursor to pass back next; use it instead of
re-reading from zero. A dropped connection loses nothing — reconnect and read on. Naming the job is
what lets a later, separate command address it again, so name it whenever the work outlives one call.

**Never re-run a command to find out whether it ran.** A job id is claimed exclusively, so starting
the same id twice returns the original job rather than a second one. An uncertain result is reported
as \`unknown\` with the command to resolve it, and \`unknown\` is not \`failed\`: treat it as a
question to answer, never as a reason to run the thing again.

**Everything after \`--\` is argv, verbatim.** No shell is involved unless you ask for one explicitly
with \`-- bash -lc '…'\`. Pass secrets through \`--env\`, never in argv: on the target, argv is
visible in \`/proc\` to every local user, and this fleet never returns a full argv to you either.

**Files move as trees, by digest.** \`cxx remote push SRC DST\` and \`cxx remote pull SRC DST\` send
only what differs and resume by being run again. Remember that remote execution does not make your
local file tools remote: read a file on the target with \`cxx remote get\`, and do not patch locally
what you read there.

**This is not a sandbox.** \`cxx remote exec\` is unsandboxed execution on another machine, with the
reach of whatever user the key authenticates as. Work on a named target for the task you were given,
report what you changed and where, and do not treat a reachable host as an invitation.`;
