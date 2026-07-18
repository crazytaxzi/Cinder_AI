import { describe, expect, it } from 'vitest';
import { pcmToWav } from '../src/voice/wav.js';

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
});
