# Credential resilience across sessions

This contract applies to cxx 0.8.1 and newer, for both `cdx` and `clx`.
Canonical credentials remain engine-specific. A transport success alone does
not authorize credential adoption: the server must verify the winning generation.
Publishing the release does not retrofit an already-running older wrapper;
these lifecycle guards take effect when the host updates to 0.8.1 and starts
the new wrapper/worker. Existing native sessions are not force-restarted.

## Session lifecycle

Startup retains the existing auth decision gate, local freshness fallback, and
explicit login/logout handling. A retryable runner or network failure does not
become a definitive invalid-credential verdict. Expired access tokens with live
refresh material are not probed by spending that material; native engines still
perform their own refresh.

During a managed session, the wrapper checks native credentials every two
seconds and offers new usable generations promptly. A failed unchanged
generation retries after five seconds with exponential backoff capped at one
minute; a newer generation bypasses that backoff. Synchronization starts
immediately, offering unsubmitted local changes first. With local credentials
already bound, canonical retrieval is due every 30 seconds even when bytes are
unchanged, subject to retry backoff.
`/auth` retrieval reads the stored verdict without launching a runner probe.

Unsubmitted local changes are arbitrated before replacement. Verified canonical
responses from store and retrieve can update disk during an active child.
Writes compare the exact observed credential and logout marker: a concurrent
native refresh, manual login, deletion, or logout takes precedence. In-flight
responses cannot recreate a removed file. Atomic replacement does not make the
final file-check-to-rename interval an OS-level compare-and-swap against native
writers that do not participate in the wrapper lock.

Claude sync preserves this host's unrelated native credential entries, including
MCP OAuth state, and never uploads or imports another host's entries. Account
generation tracking ignores MCP-only edits while full-file comparison still
protects concurrent local writes.

Watcher shutdown cancels and drains work before the final upload. Unchanged
credentials skip that upload only when already bound to canonical storage, so
a session launched through offline fallback still retries an unsent login. Final upload
precedes optional native-engine updates. Explicit wrapper updates reconcile
pending native auth before maintenance/re-exec cleanup; failed arbitration stops
the update without initiating a new insecure purge request.

Failed final upload or required write-back is visible and makes an otherwise
successful invocation fail; mid-session and background failures log and retry.
Required insecure-host cleanup remains in force. If the control plane stays
unreachable after bounded retries, remote durability and removal of the final
local credential cannot both be guaranteed: that failure is reported rather
than silently retaining spendable credentials or claiming synchronization.

## Background continuity

The per-user worker handles both engines independently even with agent messaging
disabled. Installation and cron maintenance ensure the worker for both engines.
Native changes after a foreground wrapper exits are uploaded; exact canonical
bindings avoid no-op uploads after worker restarts or another local sync.
Idle propagation uses the internal `auth-upload-auto` path: it respects logout
intent, never downloads credentials, and cannot initiate insecure cleanup of
an unsaved candidate when the upload fails.

The worker also retrieves canonical changes every 30 seconds while an existing
native-child lease proves a managed engine is active. Internal `auth-sync`
rechecks this condition and requires existing usable credentials. It starts no
model, native refresh, settings sync, or update, and cannot recreate auth purged
after the final insecure session. Detached children retaining the inherited
lease are covered. Unwrapped processes or daemons that close that descriptor
retain upload coverage but cannot prove eligibility for background downloads.

The effective `CODEX_HOME` is preserved in service, cron, and session MCP
environments. Custom stores have separate credential-change notices.

## Running-agent notices

Verified adoption during active sync publishes an engine-scoped local notice with an opaque
generation and timestamp, never token material. Each managed session receives
the change separately at a supported boundary:

- Claude: next configured `UserPromptSubmit` hook or agent MCP tool result.
- Codex: next agent MCP tool result.

Both paths share a per-session delivery record. Failed output leaves the notice
pending, and acknowledging an older notice cannot consume a newer generation.
Auth notices do not block Stop hooks, fabricate peer messages, send UNIX reload
signals, or terminate/restart native sessions. Sessions without those integrations
still synchronize credentials but have no in-band agent notification channel.

A notice is not a native reload acknowledgement. Clients may keep a healthy
access token cached and reload disk during refresh or authentication recovery;
an account change or unrecovered failure may require resuming through the wrapper.
OpenAI documents automatic refresh during active use in its
[authentication guide](https://learn.chatgpt.com/docs/auth#login-caching).

## Canonical verification and limits

Successful gateway traffic credits only the canonical generation that request
used. Older completions cannot bless replacements, revive failed/superseded
rows, or throttle proof for a newer generation. Runner native credentials carry
no spendable refresh material. Claude debug captures use the same stripped
projection; Codex retains its required empty refresh-token field.

Native refresh spends across separate hosts are not serialized. Two hosts can
still race before the first rotation reaches canonical storage. Faster uploads,
active retrieval, guarded adoption, and background continuity reduce this window;
they do not constitute a distributed refresh lease. Verification uses synthetic
generations and controlled failure/concurrency tests, without deliberately
replaying live fleet refresh tokens.
