/** An uncertain delivery must keep its idempotency key until it is resolved. */
export class UncertainSessionWrite extends Error {}

export function transientSessionWrite(error: unknown): boolean {
  if (error instanceof UncertainSessionWrite || error instanceof TypeError) return true;
  if (!error || typeof error !== "object") return false;
  const failure = error as { status?: number; code?: string; name?: string };
  if (failure.code === "agent_portal_disabled") return false;
  return failure.name === "AbortError" || [408, 429, 500, 502, 503, 504].includes(failure.status ?? 0);
}

/**
 * Kept per mutation instance, never in storage. An exact human retry after a
 * lost response reuses the key; a confirmed success permits a new, intentional
 * identical instruction. Changing actor, session, operation or payload cannot
 * inherit the old request. The server remains the authority for authorization.
 */
export function createSessionWriter(options: {
  actor: () => string | null;
  confirmed?: (result: unknown) => boolean;
  timeoutMs?: number;
  retryDelayMs?: number;
}) {
  let owner: string | null = null;
  const pending = new Map<string, { id: string; uncertain: boolean }>();
  return async function write<T>(intent: string, perform: (id: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    const actor = options.actor();
    if (actor !== owner) { pending.clear(); owner = actor; }
    if (!actor) throw new Error("Sign in again before sending a client instruction.");
    const request = pending.get(intent) ?? { id: crypto.randomUUID(), uncertain: false };
    const { id } = request;
    pending.set(intent, request);
    const forget = () => { if (pending.get(intent) === request) pending.delete(intent); };
    for (let attempt = 0; ; attempt++) {
      if (options.actor() !== actor) {
        forget();
        throw new Error("The signed-in account changed. Review the instruction before sending again.");
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Reject even if a transport swallows the aborted response body.
          reject(new UncertainSessionWrite("Delivery was not confirmed in time. Your draft is kept; retry to confirm it."));
          controller.abort();
        }, options.timeoutMs ?? 10_000);
      });
      try {
        const result = await Promise.race([perform(id, controller.signal), deadline]);
        if (!result || typeof result !== "object" || Array.isArray(result) || (options.confirmed && !options.confirmed(result))) {
          throw new UncertainSessionWrite("The server did not confirm delivery. Your draft is kept; retry to confirm it.");
        }
        forget();
        return result;
      } catch (error) {
        const transient = transientSessionWrite(error);
        if (transient) request.uncertain = true;
        // A later denial does not undo an earlier ambiguous commit.
        else if (!request.uncertain) forget();
        if (!transient || attempt >= 1) throw error;
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 250));
    }
  };
}
