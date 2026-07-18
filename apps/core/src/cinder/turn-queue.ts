import type { Logger } from '../config/logger.js';

interface QueuedTurn<T> {
  label: string;
  priority: number;
  sequence: number;
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export class TurnQueue {
  private queue: QueuedTurn<unknown>[] = [];
  private running = false;
  private sequence = 0;

  constructor(private readonly logger: Logger) {}

  enqueue<T>(label: string, priority: number, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        label,
        priority,
        sequence: this.sequence++,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      void this.drain();
    });
  }

  size(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      try {
        this.logger.debug({ label: item.label, remaining: this.queue.length }, 'Starting Cinder turn');
        item.resolve(await item.run());
      } catch (error) {
        this.logger.error({ err: error, label: item.label }, 'Cinder turn failed');
        item.reject(error);
      }
    }

    this.running = false;
  }
}
