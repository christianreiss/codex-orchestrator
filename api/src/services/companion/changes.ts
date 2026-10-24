import { wsPublisher } from '../../ws/publisher.js';
import type { OwnerRuntime } from '../../control-plane/state/runtime.js';
/** Subscribe before the initial snapshot. Separate source changes from auth
 * changes so transport pings and revocation checks never query event history. */
export class CompanionChanges {
  source = 0;
  revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeState?: () => void;
  constructor(owner?: OwnerRuntime) {
    this.unsubscribe = wsPublisher.subscribe((event) => {
      if (/^agent_portal\./.test(event.type)) {
        this.source++;
        this.wake();
      } else if (/^(companion\.|user\.|admin\.user\.|settings\.|host\.|engine\.)/.test(event.type))
        this.wake();
    });
    if (owner) {
      let previous = owner.state.snapshot();
      this.unsubscribeState = owner.state.subscribe((next) => {
        const changed = ['adminUsers', 'companionDevices', 'versions', 'hosts'].some((name) => {
          const table = name as 'adminUsers' | 'companionDevices' | 'versions' | 'hosts';
          return next.table(table) !== previous.table(table);
        });
        previous = next;
        if (changed) this.wake();
      });
    }
  }
  private wake() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  wait(observed: number, milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || observed !== this.revision) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      timer.unref();
      this.listeners.add(done);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted || observed !== this.revision) done();
    });
  }
  close() {
    this.unsubscribe();
    this.unsubscribeState?.();
    this.wake();
    this.listeners.clear();
  }
}
