/** Launch evidence is metadata, never native output or an inferred TLS diagnosis. */
export function advisorStartupDiagnostic(
  operation: { status: string; createdAt: string } | undefined,
  turns: number,
  address: string | null | undefined,
  at = Date.now(),
) {
  if (turns !== 0 || address || !operation) return null;
  if (!['queued', 'offered', 'accepted', 'expired'].includes(operation.status)) return null;
  const created = Date.parse(operation.createdAt);
  if (!Number.isFinite(created)) return null;
  return {
    code: operation.status === 'expired' ? 'advisor_startup_timeout' : 'advisor_startup_pending',
    phase: operation.status,
    elapsed_seconds: Math.max(0, Math.floor((at - created) / 1000)),
    offer_timeout_seconds: operation.status === 'accepted' ? null : 600,
    action: 'Check the advisor container logs and daemon connectivity on the orchestrator host; verify its API TLS trust. Do not disable TLS verification.',
  };
}
