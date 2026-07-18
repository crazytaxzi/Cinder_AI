import { describe, expect, it } from 'vitest';
import { TurnQueue } from '../src/cinder/turn-queue.js';

const logger = {
  debug: () => undefined,
  error: () => undefined,
} as never;

describe('TurnQueue', () => {
  it('serializes turns and prioritizes queued urgent work', async () => {
    const queue = new TurnQueue(logger);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = queue.enqueue('first', 1, async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
    });
    await Promise.resolve();
    const low = queue.enqueue('low', 1, async () => { order.push('low'); });
    const high = queue.enqueue('high', 100, async () => { order.push('high'); });
    release();
    await Promise.all([first, low, high]);

    expect(order).toEqual(['first-start', 'first-end', 'high', 'low']);
  });
});
