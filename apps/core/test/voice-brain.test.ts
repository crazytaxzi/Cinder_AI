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
  it('lets compact mini directly author an ordinary voice response without a full turn', async () => {
    let payload: Record<string, unknown> | undefined;
    const usage: Array<{ model: string }> = [];
    const tools = { assertSchemasValid: () => undefined };
    const brain = new CinderBrain(config, { warn: () => undefined, info: () => undefined } as never, tools as never, {
      recordModelUsage: async (input) => { usage.push({ model: input.model }); },
    });
    await brain.initialize();
    let fullTurns = 0;
    brain.takeTurn = async () => {
      fullTurns += 1;
      return { turnId: 'full', text: 'The engines deny everything.', silent: false, toolCalls: 0, requestIds: ['req_full'] };
    };
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
    expect(payload?.model).toBe('gpt-5.4-mini');
    expect(JSON.stringify(payload)).not.toContain('enormousSecretTopology');
    expect(usage).toEqual([{ model: 'gpt-5.4-mini' }]);
    expect(fullTurns).toBe(0);
  });

  it('suppresses acknowledgements without spending a model request', async () => {
    const tools = { assertSchemasValid: () => undefined };
    const brain = new CinderBrain(config, { warn: () => undefined, info: () => undefined } as never, tools as never);
    await brain.initialize();
    let requests = 0;
    (brain.getOpenAIClient().responses as unknown as { create: () => Promise<unknown> }).create = async () => {
      requests += 1;
      throw new Error('Acknowledgements must not reach OpenAI.');
    };
    const current = voiceEvent('current', 'Gaia', 'Mhm.');
    const scene: Scene = {
      current, recentEvents: [], relevantMemories: [], pendingApprovals: [], recentActions: [], activeVoiceParticipants: [],
    };

    const result = await brain.takeVoiceTurn(scene);

    expect(result.silent).toBe(true);
    expect(requests).toBe(0);
  });

  it('clears stale context and carries explicit session corrections', async () => {
    let payload: Record<string, unknown> | undefined;
    const tools = { assertSchemasValid: () => undefined };
    const brain = new CinderBrain(config, { warn: () => undefined, info: () => undefined } as never, tools as never);
    await brain.initialize();
    (brain.getOpenAIClient().responses as unknown as { create: (input: Record<string, unknown>) => Promise<unknown> }).create = async (input) => {
      payload = input;
      return {
        output_text: JSON.stringify({
          decision: 'respond', text: 'Understood. What now? 😼', topic: 'correction',
          engaged_users: ['Sentionce'], reason: 'Apply the correction.',
        }),
        output: [], usage: { input_tokens: 500, output_tokens: 20 }, _request_id: 'req_voice',
      };
    };
    const current = voiceEvent('current', 'Sentionce', 'Stop asking questions and focus on something else. No emojis.');
    const scene: Scene = {
      current,
      recentEvents: [voiceEvent('previous', 'Cinder', 'Tell me more about your sleep?')],
      relevantMemories: [], pendingApprovals: [], recentActions: [], activeVoiceParticipants: [],
    };

    const result = await brain.takeVoiceTurn(scene);
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('Tell me more about your sleep');
    expect(serialized).toContain('Never use emoji.');
    expect(serialized).toContain('Do not ask questions unless essential');
    expect(result.text).toBe('Understood.');
  });

  it('escalates complex and tool-related voice requests to full Cinder', async () => {
    const tools = { assertSchemasValid: () => undefined };
    const brain = new CinderBrain(config, { warn: () => undefined, info: () => undefined } as never, tools as never);
    await brain.initialize();
    let fullTurns = 0;
    brain.takeTurn = async () => {
      fullTurns += 1;
      return { turnId: 'full', text: 'I will check that.', silent: false, toolCalls: 1, requestIds: ['req_full'] };
    };
    (brain.getOpenAIClient().responses as unknown as { create: () => Promise<unknown> }).create = async () => ({
      output_text: JSON.stringify({
        decision: 'escalate', text: '', topic: 'moderation', engaged_users: ['Sera'],
        reason: 'The current request needs a moderation tool.',
      }),
      output: [], usage: { input_tokens: 500, output_tokens: 20 }, _request_id: 'req_voice',
    });
    const current = voiceEvent('current', 'Sera', 'Cinder, check whether that user needs a timeout.');
    const scene: Scene = {
      current, recentEvents: [], relevantMemories: [], pendingApprovals: [], recentActions: [],
      activeVoiceParticipants: [],
    };

    const result = await brain.takeVoiceTurn(scene);

    expect(result.text).toBe('I will check that.');
    expect(fullTurns).toBe(1);
  });
});
