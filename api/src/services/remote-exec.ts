/** Reserved fleet configuration gate for the unfinished `cxx remote` surface. */
export const REMOTE_EXEC_ENABLED_KEY = 'remote_exec_enabled';

export const REMOTE_EXEC_GUIDANCE = `## Remote execution

The \`cxx remote\` command family is reserved and unavailable in this release. Its parser and
signed configuration gate exist, but all operational verbs return \`E_NOT_IMPLEMENTED\`.
Enabling the fleet switch does not provide SSH transport, remote jobs or file transfer.

Use ordinary SSH tools when the operator's task and existing permissions authorize them.
Name the target and report the result; do not treat network reachability as authorization.
This configuration switch does not restrict ordinary SSH access.`;
