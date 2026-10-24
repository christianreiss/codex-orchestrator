import { withOwnerBackgroundScope } from './state/runtime.js';
export interface DeadlineClock {
  now(): number;
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}
const systemClock: DeadlineClock = {
  now: () => Date.now(),
  set(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
interface Entry {
  key: string;
  at: number;
  run: () => void | Promise<void>;
  order: number;
}

/** Indexed heap: one timer for the next real obligation, no empty wakeups. */
export class DeadlineQueue {
  private heap: Entry[] = [];
  private positions = new Map<string, number>();
  private timer: unknown;
  private order = 0;
  private closed = false;
  constructor(
    private readonly onError: (error: unknown, key: string) => void,
    private readonly clock = systemClock,
  ) {}

  schedule(key: string, at: number, run: Entry['run']): void {
    if (this.closed) throw new Error('Deadline queue closed');
    if (!key || !Number.isFinite(at)) throw new TypeError('Invalid deadline');
    this.remove(key);
    const entry = { key, at, run, order: this.order++ };
    this.positions.set(key, this.heap.length);
    this.heap.push(entry);
    this.up(this.heap.length - 1);
    this.arm();
  }
  cancel(key: string): void {
    this.remove(key);
    this.arm();
  }
  size(): number {
    return this.heap.length;
  }
  next(): number | undefined {
    return this.heap[0]?.at;
  }
  close(): void {
    this.closed = true;
    this.disarm();
    this.heap = [];
    this.positions.clear();
  }
  /** Called on a known clock correction; admission also checks absolute expiry. */
  clockChanged(): void {
    this.arm();
  }
  private before(a: Entry, b: Entry): boolean {
    return a.at < b.at || (a.at === b.at && a.order < b.order);
  }
  private swap(a: number, b: number): void {
    [this.heap[a], this.heap[b]] = [this.heap[b]!, this.heap[a]!];
    this.positions.set(this.heap[a]!.key, a);
    this.positions.set(this.heap[b]!.key, b);
  }
  private up(index: number): number {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(this.heap[index]!, this.heap[parent]!)) break;
      this.swap(index, parent);
      index = parent;
    }
    return index;
  }
  private down(index: number): void {
    for (;;) {
      const left = index * 2 + 1,
        right = left + 1;
      let candidate = index;
      if (left < this.heap.length && this.before(this.heap[left]!, this.heap[candidate]!)) candidate = left;
      if (right < this.heap.length && this.before(this.heap[right]!, this.heap[candidate]!))
        candidate = right;
      if (candidate === index) return;
      this.swap(index, candidate);
      index = candidate;
    }
  }
  private remove(key: string): void {
    const index = this.positions.get(key);
    if (index === undefined) return;
    this.positions.delete(key);
    const last = this.heap.pop()!;
    if (index === this.heap.length) return;
    this.heap[index] = last;
    this.positions.set(last.key, index);
    this.down(this.up(index));
  }
  private disarm(): void {
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
  }
  private arm(): void {
    this.disarm();
    const first = this.heap[0];
    if (this.closed || !first) return;
    this.timer = this.clock.set(
      () => this.fire(),
      Math.min(2_147_483_647, Math.max(0, first.at - this.clock.now())),
    );
  }
  private fire(): void {
    this.timer = undefined;
    const due: Entry[] = [];
    const now = this.clock.now();
    while (this.heap[0] && this.heap[0].at <= now) {
      const entry = this.heap[0];
      this.remove(entry.key);
      due.push(entry);
    }
    this.arm();
    for (const entry of due) {
      if (this.closed) break;
      try {
        Promise.resolve(withOwnerBackgroundScope(() => entry.run())).catch((error) =>
          this.onError(error, entry.key),
        );
      } catch (error) {
        this.onError(error, entry.key);
      }
    }
  }
}
