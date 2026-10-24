import { AsyncLocalStorage } from 'node:async_hooks';
/** Transport-supplied bridge proof. Never read from model-authored tool arguments. */
export interface NativePrincipal {
  readonly sessionId: string;
  readonly bridgeToken: string;
}
const principal = new AsyncLocalStorage<NativePrincipal>();
export function withNativePrincipal<T>(value: NativePrincipal, run: () => T): T {
  return principal.run(value, run);
}
export function currentNativePrincipal(): NativePrincipal | undefined {
  return principal.getStore();
}
