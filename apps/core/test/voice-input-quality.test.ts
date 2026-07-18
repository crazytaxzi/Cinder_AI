import { describe, expect, it } from 'vitest';
import type { EventEnvelope, Scene } from '@cinder/shared';
import { pcmHasSpeechEnergy, sanitizeVoiceTranscript } from '../src/voice/input-quality.js';
import { voiceControlToolForScene } from '../src/voice/intents.js';

function scene(text: string, platform: EventEnvelope['platform'] = 'discord_voice'): Scene {
  return {
    current: {
      id: 'voice-test', platform, occurredAt: new Date().toISOString(),
      actor: { platform: 'discord', platformUserId: 'user', displayName: 'User', roles: [], isBot: false },
      text, mentions: [], attachments: [], metadata: { verified: true },
    },
    recentEvents: [], relevantMemories: [], pendingApprovals: [], recentActions: [], activeVoiceParticipants: [],
  };
}

describe('voice input quality', () => {
  it.each([
    '[BLANK_AUDIO]', '(laughs)', '[laughter]', '(whoosh)',
    'Discord voice conversation. Cinder is a participant.',
    'Context: Discord voice conversation. Participant names may include: Gaia.',
  ])('rejects non-speech and prompt leakage: %s', (value) => {
    expect(sanitizeVoiceTranscript(value)).toBeUndefined();
  });

  it('keeps genuine conversational speech', () => {
    expect(sanitizeVoiceTranscript('Cinder, what role does HighwayHero have?'))
      .toBe('Cinder, what role does HighwayHero have?');
  });

  it('rejects silence and short receiver fragments', () => {
    expect(pcmHasSpeechEnergy(Buffer.alloc(48_000 * 2 * 2))).toBe(false);
    const short = Buffer.alloc(Math.floor(48_000 * 2 * 2 * 0.2));
    for (let offset = 0; offset + 1 < short.length; offset += 2) short.writeInt16LE(4_000, offset);
    expect(pcmHasSpeechEnergy(short)).toBe(false);
  });

  it('accepts a voiced half-second PCM clip', () => {
    const pcm = Buffer.alloc(Math.floor(48_000 * 2 * 2 * 0.5));
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      pcm.writeInt16LE(Math.round(Math.sin(offset / 40) * 4_000), offset);
    }
    expect(pcmHasSpeechEnergy(pcm)).toBe(true);
  });
});

describe('voice action routing', () => {
  it('routes explicit current join and leave requests', () => {
    expect(voiceControlToolForScene(scene('Cinder, rejoin the voice lobby and stay.'))).toBe('discord_join_voice');
    expect(voiceControlToolForScene(scene('You can leave now.'))).toBe('discord_leave_voice');
  });

  it('does not infer a leave action from ambient speech', () => {
    expect(voiceControlToolForScene(scene('Mhm.'))).toBeUndefined();
    expect(voiceControlToolForScene(scene('Why did you leave earlier?'))).toBeUndefined();
  });
});
