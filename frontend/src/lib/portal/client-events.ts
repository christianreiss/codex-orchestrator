export type ClientFeedState = "connecting" | "live" | "reconnecting";

type EventFeed = Pick<EventTarget, "addEventListener"> & { close(): void; readonly readyState?: number };

/** Refresh snapshots on reconnect; never infer client presence from the event transport. */
export function watchClientEvents(options: {
  sessionId: string;
  create?: (url: string) => EventFeed;
  status: (state: ClientFeedState) => void;
  refresh: (timeline: boolean) => void;
  debounceMs?: number;
}): () => void {
  let stopped = false;
  let source: EventFeed | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let silence: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let timelineDirty = false;
  const clearSilence = () => { if (silence) clearTimeout(silence); silence = null; };
  const flush = () => {
    pending = null;
    if (stopped) return;
    const timeline = timelineDirty;
    timelineDirty = false;
    options.refresh(timeline);
  };
  function reconnect() {
    if (stopped || retry) return;
    clearSilence();
    const previous = source;
    source = null;
    previous?.close();
    options.status("reconnecting");
    retry = setTimeout(() => { retry = null; connect(); }, Math.min(1000 * 2 ** attempts++, 30_000));
  }
  function armSilence() {
    clearSilence();
    // Named server heartbeat frames arrive every15s. An OPEN socket alone is
    // not proof the stream still works through a proxy or sleeping connection.
    silence = setTimeout(reconnect, 45_000);
  }
  function connect() {
    if (stopped) return;
    options.status(attempts ? "reconnecting" : "connecting");
    let current: EventFeed;
    try {
      current = (options.create ?? ((url) => new EventSource(url)))(
        `/admin/agent-sessions/events?session_id=${encodeURIComponent(options.sessionId)}`,
      );
      source = current;
    } catch { reconnect(); return; }
    const valid = () => !stopped && source === current;
    armSilence();
    current.addEventListener("open", () => {
      if (!valid()) return;
      attempts = 0;
      options.status("live");
      armSilence();
      // Refresh also recovers events outside the previous stream cursor window.
      options.refresh(true);
    });
    current.addEventListener("heartbeat", () => { if (valid()) armSilence(); });
    const failed = () => {
      if (!valid()) return;
      options.status("reconnecting");
      // CONNECTING lets EventSource retain its Last-Event-ID/native retry.
      // CLOSED (for example a rejected request) needs an explicit bounded retry.
      if (current.readyState === 2) reconnect();
    };
    current.addEventListener("error", failed);
    current.addEventListener("unavailable", failed);
    current.addEventListener("agent", (event) => {
      if (!valid()) return;
      armSilence();
      try {
        const row = JSON.parse((event as MessageEvent<string>).data) as { session_id?: string };
        timelineDirty ||= !row.session_id || row.session_id === options.sessionId;
      } catch { timelineDirty = true; }
      if (!pending) pending = setTimeout(flush, options.debounceMs ?? 400);
    });
  }
  connect();
  return () => {
    stopped = true;
    if (pending) clearTimeout(pending);
    if (retry) clearTimeout(retry);
    clearSilence();
    source?.close();
    source = null;
  };
}
