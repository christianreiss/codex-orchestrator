/**
 * Live-updates WebSocket connection status, mirrored from the WsClientHandle
 * created in the root layout so the TopBar (and anything else) can render a
 * connectivity indicator without needing a reference to the ws client itself.
 */
import { writable } from "svelte/store";

export type WsStatus = "idle" | "connecting" | "open" | "closed" | "disabled";

const { subscribe, set } = writable<WsStatus>("disabled");

export const wsStatus = {
  subscribe,
};

export function setWsStatus(status: WsStatus): void {
  set(status);
}
