import { expect, type Page, type WebSocketRoute } from "@playwright/test";

/** Give browser fixtures the same subscribed epoch/sequence contract as production. */
export function ownerStream(socket: WebSocketRoute): void {
  const send = socket.send.bind(socket);
  const epoch = "11111111-1111-4111-8111-111111111111";
  let sequence = 0n;
  socket.send = data => {
    if (typeof data !== "string") return send(data);
    const frame = JSON.parse(data);
    send(JSON.stringify({ ts: new Date().toISOString(), ...frame, epoch, sequence: String(++sequence) }));
  };
  socket.onMessage(() => send(JSON.stringify({ type: "pong", ts: new Date().toISOString() })));
  send(JSON.stringify({ type: "hello", ts: new Date().toISOString(), epoch, sequence: "0", resync: true }));
}

/** A connected owner stream for fixtures whose state changes after initial reads. */
export async function installOwnerUpdates(page: Page): Promise<(type: string, payload?: unknown) => Promise<void>> {
  let emit: ((data: string) => void) | undefined;
  await page.routeWebSocket('**/owner-test-ws', (socket) => {
    ownerStream(socket);
    emit = (data) => socket.send(data);
  });
  await page.route('**/admin/ws/info', (route) => {
    emit = undefined;
    return route.fulfill({ json: { enabled: true, url: new URL('/owner-test-ws', route.request().url()).href.replace(/^http/, 'ws') } });
  });
  return async (type, payload = {}) => {
    await expect.poll(() => Boolean(emit)).toBe(true);
    emit!(JSON.stringify({ type, payload }));
  };
}
