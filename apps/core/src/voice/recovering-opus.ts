import { createRequire } from 'node:module';
import { Transform, type TransformCallback } from 'node:stream';

const require = createRequire(import.meta.url);

interface OpusPacketDecoder {
  decode(packet: Buffer): Buffer;
}

interface NativeOpusModule {
  OpusEncoder: new (rate: number, channels: number) => OpusPacketDecoder;
}

export interface RecoveringOpusDecoderOptions {
  rate?: number;
  channels?: number;
  onCorruptPacket?: (error: unknown, packetLength: number, droppedPackets: number) => void;
  decoder?: OpusPacketDecoder;
}

function createNativeDecoder(rate: number, channels: number): OpusPacketDecoder {
  const native = require('@discordjs/opus') as NativeOpusModule;
  return new native.OpusEncoder(rate, channels);
}

/**
 * Discord receive streams emit one Opus packet per chunk. A single malformed
 * packet must not poison the entire utterance, so decode packets independently
 * and drop only the bad packet while preserving decoder state for the rest.
 */
export class RecoveringOpusDecoder extends Transform {
  readonly decoder: OpusPacketDecoder;
  droppedPackets = 0;

  constructor(private readonly options: RecoveringOpusDecoderOptions = {}) {
    super({ writableObjectMode: true });
    this.decoder = options.decoder ?? createNativeDecoder(options.rate ?? 48_000, options.channels ?? 2);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const packet = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const pcm = this.decoder.decode(packet);
      if (pcm.length > 0) this.push(pcm);
    } catch (error) {
      this.droppedPackets += 1;
      this.options.onCorruptPacket?.(
        error,
        Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk),
        this.droppedPackets,
      );
    }
    callback();
  }
}
