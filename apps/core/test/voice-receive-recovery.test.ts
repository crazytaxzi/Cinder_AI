import { describe, expect, it } from 'vitest';
import {
  VOICE_RECEIVE_CORRUPT_PACKET_LIMIT,
  shouldRecoverVoiceReceive,
} from '../src/voice/receive-recovery.js';

describe('voice receive recovery policy', () => {
  it('rebuilds a voice session when every decoded packet is lost', () => {
    expect(shouldRecoverVoiceReceive({
      corruptPackets: 1,
      decodedBytes: 0,
      lastRecoveryAt: 0,
      now: 20_000,
    })).toBe(true);
  });

  it('rebuilds after repeated corruption even when partial PCM survived', () => {
    expect(shouldRecoverVoiceReceive({
      corruptPackets: VOICE_RECEIVE_CORRUPT_PACKET_LIMIT,
      decodedBytes: 48_000,
      lastRecoveryAt: 0,
      now: 20_000,
    })).toBe(true);
  });

  it('does not reconnect-loop during the cooldown', () => {
    expect(shouldRecoverVoiceReceive({
      corruptPackets: 10,
      decodedBytes: 0,
      lastRecoveryAt: 10_000,
      now: 20_000,
      cooldownMs: 15_000,
    })).toBe(false);
  });

  it('leaves healthy decoded audio alone', () => {
    expect(shouldRecoverVoiceReceive({
      corruptPackets: 0,
      decodedBytes: 96_000,
      lastRecoveryAt: 0,
      now: 20_000,
    })).toBe(false);
  });
});
