import { describe, expect, it } from 'vitest';
import type { EventEnvelope, Scene } from '@cinder/shared';
import { loadConfig } from '../src/config/env.js';
import { CinderBrain } from '../src/cinder/brain.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://test', OPENAI_API_KEY: 'x', DISCORD_TOKEN: 'x',
  DISCORD_APPLICATION_ID: '1', DISCORD_GUILD_ID: '2',
  DASHBOARD_ADMIN_PASSWORD_HASH: 'scrypt-test-dashboard-password-hash',
  DASHBOARD_SESSION_SECRET: 'session-secret-session-secret-session-secret-session-secret',
  CINDER_INTERNAL_CONTROL_TOKEN: 'control-token-control-token-control-token-control-token',
  CINDER_PROFILE_PATH: '../../config/cinder-profile.md',
});

function voiceEvent(id: string, speaker: string, text: string): EventEnvelope {
  return {
    id, platform: 'discord_voice', occurredAt: new Date().toISOString(),
    serverId: 'guild', channelId: 'voice', voiceChannelId: 'voice',
    actor: { platform: 'discord', platformUserId: speaker, displayName: speaker, roles: [], isBot: false },
    text, mentions: [], attachments: [], metadata: { verified: true },
  };
}

describe('compact voice cognition', () => {
  it('uses the nano social model and excludes full server topology', async () => {
    let payload: Record<string, unknown> | undefined;
    const usage: Array<{ model: string }> = [];
    const tools = { assertSchemasValid: () => undefined };
    const brain = new CinderBrain(config, { warn: () => undefined, info: () => undefined } as never, tools as never, {
      recordModelUsage: async (input) => { usage.push({ model: input.model }); },
    });
    await brain.initialize();
    const fakeResponse = {
      output_text: JSON.stringify({
        decision: 'respond', text: 'The engines deny everything.', topic: 'engines',
        engaged_users: ['Sera'], reason: 'A useful callback fits.',
      }),
      output: [],
      usage: { input_tokens: 900, output_tokens: 30, input_tokens_details: { cached_tokens: 0 } },
      _request_id: 'req_voice',
    };
    (brain.getOpenAIClient().responses as unknown as { create: (input: Record<string, unknown>) => Promise<unknown> }).create = async (input) => {
      payload = input;
      return fakeResponse;
    };
    const current = voiceEvent('current', 'Sera', 'Cinder would blame the engines.');
    const scene: Scene = {
      current,
      recentEvents: [voiceEvent('previous', 'Baz', 'The ship is too heavy.')],
      relevantMemories: [], pendingApprovals: [], recentActions: [], activeVoiceParticipants: [],
      serverSnapshot: { enormousSecretTopology: 'must-not-be-sent' },
    };
    const result = await brain.takeVoiceTurn(scene);

    expect(result.text).toBe('The engines deny everything.');
    expect(payload?.model).toBe('gpt-5.4-nano');
    expect(JSON.stringify(payload)).not.toContain('enormousSecretTopology');
    expect(usage).toEqual([{ model: 'gpt-5.4-nano' }]);
  });
});
