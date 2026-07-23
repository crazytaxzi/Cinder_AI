import { createRequire } from 'node:module';
import { Transform, type TransformCallback } from 'node:stream';
import prism from 'prism-media';

const require = createRequire(import.meta.url);
const PATCH_FLAG = Symbol.for('cinder.recovering-prism-opus');

interface OpusPacketDecoder {
  decode(packet: Buffer): Buffer;
}

interface NativeOpusModule {
  OpusEncoder: new (rate: number, channels: number) => OpusPacketDecoder;
}

interface RecoverablePrismDecoder extends Transform {
  _decode(packet: Buffer): Buffer;
  [PATCH_FLAG]?: boolean;
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
 * Packet-level decoder used by tests and by callers that want explicit control.
 * Discord receive streams emit one Opus packet per chunk. A single malformed
 * packet must not poison the entire utterance.
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

/**
 * Cinder already constructs prism-media decoders inside VoiceManager. Patch the
 * decoder once at process startup so one invalid Discord packet is discarded
 * instead of emitting an error that kills the entire speaker utterance.
 */
export function installRecoveringPrismOpusDecoder(): void {
  const prototype = prism.opus.Decoder.prototype as unknown as RecoverablePrismDecoder;
  if (prototype[PATCH_FLAG]) return;

  prototype[PATCH_FLAG] = true;
  prototype._transform = function recoveringTransform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      callback(null, this._decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    } catch (error) {
      this.emit('corruptPacket', error, Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
      callback();
    }
  };
}

installRecoveringPrismOpusDecoder();
