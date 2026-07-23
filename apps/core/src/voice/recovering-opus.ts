import { createRequire } from 'node:module';
import { Transform, type TransformCallback } from 'node:stream';
import prism from 'prism-media';

const require = createRequire(import.meta.url);
const patchedPrototypes = new WeakSet<object>();

interface OpusPacketDecoder {
  decode(packet: Buffer): Buffer | Uint8Array;
  delete?(): void;
}

interface NativeOpusModule {
  OpusEncoder: new (rate: number, channels: number) => OpusPacketDecoder;
}

interface OpusScriptModule {
  new (rate: number, channels: number, application: number): OpusPacketDecoder;
  Application: { AUDIO: number };
}

interface RecoverablePrismDecoder extends Transform {
  _decode(packet: Buffer): Buffer;
}

interface DecoderState {
  fallback: OpusPacketDecoder | undefined;
  fallbackActive: boolean;
  cleaned: boolean;
}

export interface RecoveringOpusDecoderOptions {
  rate?: number;
  channels?: number;
  onCorruptPacket?: (error: unknown, packetLength: number, droppedPackets: number) => void;
  onFallback?: (error: unknown, packetLength: number, fallbackPackets: number) => void;
  decoder?: OpusPacketDecoder;
  fallbackDecoder?: OpusPacketDecoder;
}

function createNativeDecoder(rate: number, channels: number): OpusPacketDecoder {
  const native = require('@discordjs/opus') as NativeOpusModule;
  return new native.OpusEncoder(rate, channels);
}

function createScriptDecoder(rate: number, channels: number): OpusPacketDecoder {
  const OpusScript = require('opusscript') as OpusScriptModule;
  return new OpusScript(rate, channels, OpusScript.Application.AUDIO);
}

function asBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function combinedDecodeError(primary: unknown, fallback: unknown): AggregateError {
  return new AggregateError(
    [primary, fallback],
    'Both native and JavaScript Opus decoders rejected the Discord voice packet.',
  );
}

/**
 * Packet-level decoder used by tests and callers that want explicit control.
 * It switches to opusscript when the preferred native decoder rejects a packet,
 * then keeps the fallback decoder warm for the rest of the utterance.
 */
export class RecoveringOpusDecoder extends Transform {
  readonly decoder: OpusPacketDecoder;
  private readonly fallbackDecoder: OpusPacketDecoder;
  private fallbackActive = false;
  droppedPackets = 0;
  fallbackPackets = 0;

  constructor(private readonly options: RecoveringOpusDecoderOptions = {}) {
    super({ writableObjectMode: true });
    const rate = options.rate ?? 48_000;
    const channels = options.channels ?? 2;
    this.decoder = options.decoder ?? createNativeDecoder(rate, channels);
    this.fallbackDecoder = options.fallbackDecoder ?? createScriptDecoder(rate, channels);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const packet = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    try {
      const pcm = this.fallbackActive
        ? asBuffer(this.fallbackDecoder.decode(packet))
        : asBuffer(this.decoder.decode(packet));
      if (pcm.length > 0) this.push(pcm);
      callback();
      return;
    } catch (primaryError) {
      if (!this.fallbackActive) {
        try {
          const pcm = asBuffer(this.fallbackDecoder.decode(packet));
          this.fallbackActive = true;
          this.fallbackPackets += 1;
          this.options.onFallback?.(primaryError, packet.length, this.fallbackPackets);
          if (pcm.length > 0) this.push(pcm);
          callback();
          return;
        } catch (fallbackError) {
          this.droppedPackets += 1;
          this.options.onCorruptPacket?.(
            combinedDecodeError(primaryError, fallbackError),
            packet.length,
            this.droppedPackets,
          );
          callback();
          return;
        }
      }

      try {
        const pcm = asBuffer(this.decoder.decode(packet));
        this.fallbackActive = false;
        if (pcm.length > 0) this.push(pcm);
      } catch (nativeError) {
        this.droppedPackets += 1;
        this.options.onCorruptPacket?.(
          combinedDecodeError(nativeError, primaryError),
          packet.length,
          this.droppedPackets,
        );
      }
      callback();
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.decoder.delete?.();
    if (this.fallbackDecoder !== this.decoder) this.fallbackDecoder.delete?.();
    callback(error);
  }
}

/**
 * Cinder constructs prism-media decoders inside VoiceManager. Patch that decoder
 * once at startup so native decode failures switch the current utterance to the
 * existing opusscript fallback instead of silently erasing the speaker.
 */
export function installRecoveringPrismOpusDecoder(): void {
  const prototype = prism.opus.Decoder.prototype as unknown as RecoverablePrismDecoder;
  if (patchedPrototypes.has(prototype)) return;

  const states = new WeakMap<RecoverablePrismDecoder, DecoderState>();
  patchedPrototypes.add(prototype);
  prototype._transform = function recoveringTransform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const packet = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const state = states.get(this) ?? { fallback: undefined, fallbackActive: false, cleaned: false };
    states.set(this, state);

    const ensureFallback = (): OpusPacketDecoder => {
      if (!state.fallback) {
        state.fallback = createScriptDecoder(48_000, 2);
        const cleanup = () => {
          if (state.cleaned) return;
          state.cleaned = true;
          state.fallback?.delete?.();
          state.fallback = undefined;
        };
        this.once('end', cleanup);
        this.once('close', cleanup);
      }
      return state.fallback;
    };

    if (state.fallbackActive) {
      try {
        callback(null, asBuffer(ensureFallback().decode(packet)));
        return;
      } catch (fallbackError) {
        try {
          const pcm = this._decode(packet);
          state.fallbackActive = false;
          this.emit('decoderRecovered', packet.length);
          callback(null, pcm);
          return;
        } catch (nativeError) {
          this.emit('corruptPacket', combinedDecodeError(nativeError, fallbackError), packet.length);
          callback();
          return;
        }
      }
    }

    try {
      callback(null, this._decode(packet));
    } catch (nativeError) {
      try {
        const pcm = asBuffer(ensureFallback().decode(packet));
        state.fallbackActive = true;
        this.emit('decoderFallback', nativeError, packet.length);
        callback(null, pcm);
      } catch (fallbackError) {
        this.emit('corruptPacket', combinedDecodeError(nativeError, fallbackError), packet.length);
        callback();
      }
    }
  };
}

installRecoveringPrismOpusDecoder();
