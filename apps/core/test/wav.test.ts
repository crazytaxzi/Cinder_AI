import { describe, expect, it } from 'vitest';
import { pcmToWav } from '../src/voice/wav.js';
import { wavDurationSeconds } from '../src/voice/manager.js';

describe('pcmToWav', () => {
  it('writes a valid PCM WAV header', () => {
    const pcm = Buffer.alloc(1920);
    const wav = pcmToWav(pcm);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.subarray(36, 40).toString()).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.length).toBe(pcm.length + 44);
  });

  it('measures generated WAV duration for TTS cost accounting', () => {
    const wav = pcmToWav(Buffer.alloc(48_000 * 2 * 2));
    expect(wavDurationSeconds(wav)).toBe(1);
  });

  it('uses actual bytes when a streaming WAV declares an unknown data size', () => {
    const wav = pcmToWav(Buffer.alloc(48_000 * 2 * 2));
    wav.writeUInt32LE(0xFFFFFFFF, 40);
    expect(wavDurationSeconds(wav)).toBe(1);
  });
});
