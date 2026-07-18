import { describe, expect, it } from 'vitest';
import prism from 'prism-media';
import { transformImpVoice } from '../src/voice/manager.js';
import { pcmToWav } from '../src/voice/wav.js';

describe('voice codec runtime', () => {
  it('can construct the Opus decoder used for per-user Discord audio', () => {
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    expect(decoder).toBeDefined();
    decoder.destroy();
  });

  it('emits playable Ogg/Opus after the imp pitch and speed transform', async () => {
    const samples = 48_000;
    const pcm = Buffer.alloc(samples * 2 * 2);
    for (let frame = 0; frame < samples; frame += 1) {
      const sample = Math.round(Math.sin(2 * Math.PI * 440 * frame / 48_000) * 8_000);
      pcm.writeInt16LE(sample, frame * 4);
      pcm.writeInt16LE(sample, frame * 4 + 2);
    }
    const transformed = transformImpVoice(pcmToWav(pcm), 0.66, 0.85896448);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      transformed.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      transformed.once('end', resolve);
      transformed.once('error', reject);
    });
    const ogg = Buffer.concat(chunks);
    expect(ogg.length).toBeGreaterThan(1_000);
    expect(ogg.subarray(0, 4).toString()).toBe('OggS');
    expect(ogg.includes(Buffer.from('OpusHead'))).toBe(true);
  });
});
