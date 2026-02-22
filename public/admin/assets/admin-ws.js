(() => {
  const STORAGE_KEY = 'admin_ws_last_event_id';
  const state = {
    enabled: false,
    url: null,
    socket: null,
    retries: 0,
    reconnectTimer: null,
    lastEventId: null,
  };

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function isEventEnvelope(message) {
    return isObject(message) && message.kind === 'event' && isObject(message.event);
  }

  function loadLastEventId() {
    try {
      const stored = window.localStorage?.getItem(STORAGE_KEY);
      if (stored && /^[0-9]+$/.test(stored)) {
        state.lastEventId = stored;
      }
    } catch (err) {
      // localStorage may be blocked; ignore.
    }
  }

  function saveLastEventId(id) {
    if (!id) return;
    try {
      window.localStorage?.setItem(STORAGE_KEY, String(id));
    } catch (err) {
      // ignore storage errors
    }
  }

  function buildUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
      const url = new URL(rawUrl, window.location.href);
      if (state.lastEventId) {
        url.searchParams.set('since', state.lastEventId);
      }
      return url.toString();
    } catch (err) {
      console.warn('admin ws: invalid url', rawUrl);
      return null;
    }
  }

  function scheduleReconnect() {
    if (!state.enabled || state.reconnectTimer) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, state.retries || 0));
    state.retries += 1;
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (!state.enabled || !state.url) return;
    if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const target = buildUrl(state.url);
    if (!target) return;

    emit('admin-ws-status', { status: 'connecting' });
    const ws = new WebSocket(target);
    state.socket = ws;

    ws.onopen = () => {
      state.retries = 0;
      emit('admin-ws-status', { status: 'open' });
    };

    ws.onmessage = (event) => {
      if (!event?.data) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return;
      }

      if (!isObject(message)) {
        return;
      }

      if (isEventEnvelope(message)) {
        const eventId = Number(message.event.id || 0);
        if (Number.isFinite(eventId) && eventId > 0) {
          state.lastEventId = String(eventId);
          saveLastEventId(state.lastEventId);
        }
        emit('admin-ws-event', message.event);
        return;
      }

      emit('admin-ws-message', message);
    };

    ws.onerror = () => {
      emit('admin-ws-status', { status: 'error' });
    };

    ws.onclose = () => {
      if (state.socket === ws) {
        state.socket = null;
      }
      emit('admin-ws-status', { status: 'closed' });
      scheduleReconnect();
    };
  }

  async function fetchInfo() {
    try {
      const res = await fetch('/admin/ws/info', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const json = await res.json();
      const data = json?.data || {};
      if (!data.enabled || !data.url) return;
      state.enabled = true;
      state.url = data.url;
      const lastEventId = Number(data.last_event_id || 0);
      if (!state.lastEventId && Number.isFinite(lastEventId) && lastEventId > 0) {
        state.lastEventId = String(lastEventId);
        saveLastEventId(state.lastEventId);
      }
      connect();
    } catch (err) {
      console.warn('admin ws: info fetch failed', err);
    }
  }

  function init() {
    loadLastEventId();
    fetchInfo();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
