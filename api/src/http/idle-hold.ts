import { wsPublisher } from '../ws/publisher.js';

/**
 * Hold an empty poll open until something that could change its answer is published, or a timeout passes. Arm it
 * BEFORE the durable check: an event committed while that check runs still releases the hold at once.
 */
export function armWake(wakes: (type: string, payload: unknown) => boolean) {
  let woke = false;
  let release: (() => void) | undefined;
  const unsubscribe = wsPublisher.subscribe(({ type, payload }) => {
    if (!wakes(type, payload)) return;
    woke = true;
    release?.();
  });
  return {
    stop: unsubscribe,
    /** Resolves true when woken, false on timeout or disconnect; always unsubscribes. */
    wait(
      ms: number,
      gone: () => boolean,
      connection?: { on(event: 'close', listener: () => void): unknown; off(event: 'close', listener: () => void): unknown },
    ): Promise<boolean> {
      if (woke || ms <= 0 || gone()) {
        unsubscribe();
        return Promise.resolve(woke);
      }
      return new Promise<boolean>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          connection?.off('close', finish);
          unsubscribe();
          release = undefined;
          resolve(woke);
        };
        const timer = setTimeout(finish, ms);
        connection?.on('close', finish);
        release = finish;
      });
    },
  };
}
