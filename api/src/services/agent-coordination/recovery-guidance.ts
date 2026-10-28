/** Recovery instructions do not grant ownership; the native proof checks still apply. */
export const CLAIM_RECOVERY_GUIDANCE =
  ' For a disconnected claim, reconnect its original native instance, or resume the exact native transcript only after the previous lifecycle completed and detached, then call resource_claim_status({claim_id,renew:true}). ' +
  'A matching agent UUID alone is insufficient; reported_unknown outcomes cannot be renewed. ' +
  'Recover the Git registration separately with git_register using the same absolute worktree_path and current clone/branch/HEAD facts. ' +
  'A claim whose owner session has ended is released automatically (audited as agent_coordination.session_ended_release) unless a live successor on the same transcript can still continue it; an owner that merely lost its connection keeps it until its bridge expires and the session is finalized. ' +
  'If proof is unavailable, coordinate with the original owner or ask an operator to verify the operation ended and use POST /admin/agent-messaging/scopes/resolve with an audited reason.';

export const GIT_RECOVERY_GUIDANCE =
  ' Reconnect the original native instance, or resume the exact native transcript only after the previous lifecycle completed and detached, then call git_register using the same absolute worktree_path and current clone/branch/HEAD facts before retrying. ' +
  'Recover its resource claims separately with resource_claim_status({claim_id,renew:true}); a matching agent UUID alone is insufficient and reported_unknown outcomes cannot be renewed. ' +
  'Registration recovery withdraws prior merge grants; request a fresh merge lease. If native proof is unavailable, coordinate with the original owner or ask an operator to resolve the retained exclusion.';
