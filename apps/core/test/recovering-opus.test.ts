import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import prism from 'prism-media';
import {
  RecoveringOpusDecoder,
  installRecoveringPrismOpusDecoder,
} from '../src/voice/recovering-opus.js';

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return Buffer.concat(chunks);
}

describe('recovering Opus receive decoder', () => {
  it('drops one malformed packet and continues decoding the utterance', async () => {
    const onCorruptPacket = vi.fn();
    let calls = 0;
    const decoder = new RecoveringOpusDecoder({
      decoder: {
        decode: () => {
          calls += 1;
          if (calls === 1) throw new TypeError('The compressed data passed is corrupted');
          return Buffer.from('decoded-pcm');
        },
      },
      onCorruptPacket,
    });

    const output = collect(Readable.from([Buffer.from('bad'), Buffer.from('good')], { objectMode: true }).pipe(decoder));

    await expect(output).resolves.toEqual(Buffer.from('decoded-pcm'));
    expect(decoder.droppedPackets).toBe(1);
    expect(onCorruptPacket).toHaveBeenCalledTimes(1);
  });

  it('patches prism-media so a corrupt Discord packet does not emit a fatal stream error', async () => {
    installRecoveringPrismOpusDecoder();
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const internal = decoder as unknown as { _decode(packet: Buffer): Buffer };
    internal._decode = vi.fn()
      .mockImplementationOnce(() => { throw new TypeError('The compressed data passed is corrupted'); })
      .mockReturnValue(Buffer.from('survived'));

    const output = collect(Readable.from([Buffer.from('bad'), Buffer.from('good')], { objectMode: true }).pipe(decoder));

    await expect(output).resolves.toEqual(Buffer.from('survived'));
  });
});
