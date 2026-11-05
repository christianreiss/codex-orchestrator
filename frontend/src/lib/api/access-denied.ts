/**
 * Classifies a failed request as "you may not do this" rather than "it broke".
 *
 * Duck-typed on purpose: anything carrying `status: 403` counts, so this file
 * imports nothing and the state components can call it on whatever a query
 * hands them. A capability denial also names what was missing — the server
 * spreads `required_capability` onto the error envelope
 * (`api/src/http/plugins/capabilities.ts`), which `ApiError` keeps as `body`.
 */
export type AccessDenial = { capability: string | null };

export function accessDenied(error: unknown): AccessDenial | null {
  if (!error || typeof error !== "object") return null;
  const { status, body } = error as { status?: unknown; body?: unknown };
  if (status !== 403) return null;
  const required = body && typeof body === "object" ? (body as Record<string, unknown>).required_capability : undefined;
  return { capability: typeof required === "string" && required.trim() ? required : null };
}

/** The sentence a denied region shows: what is missing, and who can fix it. */
export function accessDeniedText(capability: string | null | undefined): string {
  return capability
    ? `You need the ${capability} capability. An owner or admin can grant it.`
    : "Your account's role does not allow this. An owner or admin can grant it.";
}

/** The message an error region shows for a non-denial failure. */
export function errorText(error: unknown): string | null {
  if (error === null || error === undefined || error === false) return null;
  if (typeof error === "string") return error || null;
  if (error instanceof Error) return error.message || "Something went wrong.";
  return "Something went wrong.";
}

/**
 * What a list hands `DataTable.error`: the error itself when it is a denial
 * (so the table can say "No access"), otherwise the message, optionally
 * prefixed with the resource that failed to load.
 */
export function loadFailure(error: unknown, prefix?: string): Error | string | null {
  if (error === null || error === undefined || error === false) return null;
  if (accessDenied(error)) return error as Error;
  const text = errorText(error) ?? "Something went wrong.";
  return prefix ? `${prefix}: ${text}` : text;
}
