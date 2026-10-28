/** Recovery instructions do not grant ownership; the native proof checks still apply. */
export const CLAIM_RECOVERY_GUIDANCE =
  ' For a disconnected claim, reconnect its original native instance, or resume the exact native transcript only after the previous lifecycle completed and detached, then call resource_claim_status({claim_id,renew:true}). ' +
  'A matching agent UUID alone is insufficient; reported_unknown outcomes cannot be renewed. ' +
  'Recover the Git registration separately with git_register using the same absolute worktree_path and current clone/branch/HEAD facts. ' +
  'Nobody keeps an offline agent\'s claim: once its owner session has ended, or the owner has been disconnected for 5 minutes, the claim is released automatically (audited as agent_coordination.session_ended_release or agent_coordination.owner_offline_release) unless a present successor on the same transcript can still continue it. Wait for that instead of taking the resource over. ' +
  'Only a reported_unknown outcome needs an operator: verify the operation ended and use POST /admin/agent-messaging/scopes/resolve with an audited reason.';

export const GIT_RECOVERY_GUIDANCE =
  ' Reconnect the original native instance, or resume the exact native transcript only after the previous lifecycle completed and detached, then call git_register using the same absolute worktree_path and current clone/branch/HEAD facts before retrying. ' +
  'Recover its resource claims separately with resource_claim_status({claim_id,renew:true}); a matching agent UUID alone is insufficient and reported_unknown outcomes cannot be renewed. ' +
  'Registration recovery withdraws prior merge grants; request a fresh merge lease. ' +
  'A registration whose owner session ended, or whose owner has been disconnected for 5 minutes, is abandoned automatically (with its merge requests) and its worktree_path can then be registered by any session; wait for that instead of evicting it.';
