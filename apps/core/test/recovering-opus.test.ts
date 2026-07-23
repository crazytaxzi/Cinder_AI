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
  it('switches to the JavaScript fallback when native Opus rejects a packet', async () => {
    const onFallback = vi.fn();
    const native = { decode: vi.fn(() => { throw new TypeError('The compressed data passed is corrupted'); }) };
    const fallback = { decode: vi.fn(() => Buffer.from('fallback-pcm')) };
    const decoder = new RecoveringOpusDecoder({
      decoder: native,
      fallbackDecoder: fallback,
      onFallback,
    });

    const output = collect(Readable.from([Buffer.from('packet')], { objectMode: true }).pipe(decoder));

    await expect(output).resolves.toEqual(Buffer.from('fallback-pcm'));
    expect(native.decode).toHaveBeenCalledTimes(1);
    expect(fallback.decode).toHaveBeenCalledTimes(1);
    expect(decoder.fallbackPackets).toBe(1);
    expect(decoder.droppedPackets).toBe(0);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('drops only packets rejected by both decoders and continues the utterance', async () => {
    const onCorruptPacket = vi.fn();
    let nativeCalls = 0;
    let fallbackCalls = 0;
    const decoder = new RecoveringOpusDecoder({
      decoder: {
        decode: () => {
          nativeCalls += 1;
          if (nativeCalls === 1) throw new TypeError('native rejected packet');
          return Buffer.from('decoded-pcm');
        },
      },
      fallbackDecoder: {
        decode: () => {
          fallbackCalls += 1;
          throw new TypeError('fallback rejected packet');
        },
      },
      onCorruptPacket,
    });

    const output = collect(Readable.from([Buffer.from('bad'), Buffer.from('good')], { objectMode: true }).pipe(decoder));

    await expect(output).resolves.toEqual(Buffer.from('decoded-pcm'));
    expect(fallbackCalls).toBe(1);
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

    const decoded = await output;
    expect(decoded.subarray(-Buffer.byteLength('survived'))).toEqual(Buffer.from('survived'));
  });
});
