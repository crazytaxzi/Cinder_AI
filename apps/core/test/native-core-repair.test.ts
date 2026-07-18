import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope, Scene } from '@cinder/shared';
import { loadConfig } from '../src/config/env.js';
import { CinderBrain } from '../src/cinder/brain.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { normalizeName } from '../src/adapters/discord.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://test',
  OPENAI_API_KEY: 'test-openai',
  DISCORD_TOKEN: 'test-discord',
  DISCORD_APPLICATION_ID: '1',
  DISCORD_GUILD_ID: '2',
  DASHBOARD_ADMIN_PASSWORD_HASH: 'scrypt-test-dashboard-password-hash',
  DASHBOARD_SESSION_SECRET: 'session-secret-session-secret-session-secret-session-secret',
  CINDER_INTERNAL_CONTROL_TOKEN: 'control-token-control-token-control-token-control-token',
});

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as never;

function scene(platform: EventEnvelope['platform'] = 'discord_text'): Scene {
  return {
    current: {
      id: `event:${platform}`,
      platform,
      occurredAt: new Date().toISOString(),
      serverId: 'guild',
      channelId: 'channel',
      actor: {
        platform: platform.startsWith('twitch') ? 'twitch' : 'discord',
        platformUserId: 'speaker',
        displayName: 'Alex',
        roles: ['Moderator'],
        isBot: false,
      },
      text: 'Talk to me naturally.',
      mentions: [],
      attachments: [],
      metadata: { verified: true, directMention: true },
    },
    recentEvents: [], relevantMemories: [], pendingApprovals: [], recentActions: [],
    activeVoiceParticipants: [],
  };
}

function mockBrain(responses: Array<Record<string, unknown>>, execute = vi.fn(), usageRecorder?: { recordModelUsage: ReturnType<typeof vi.fn> }) {
  const tools = {
    definitions: () => [{
      type: 'function', name: 'stay_silent', description: 'silence', strict: true,
      parameters: {
        type: 'object', properties: { reason: { type: 'string' } },
        required: ['reason'], additionalProperties: false,
      },
    }],
    assertSchemasValid: () => undefined,
    toolNames: () => ['stay_silent'],
    execute,
  };
  const brain = new CinderBrain(config, logger, tools as never, usageRecorder);
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('No mocked OpenAI response remains.');
    return next;
  });
  (brain as unknown as { openai: { responses: { create: typeof create } } }).openai = {
    responses: { create },
  };
  return { brain, create, execute };
}

describe('repaired OpenAI cognitive loop', () => {
  it('resolves visually decorated Discord channel names to plain references', () => {
    expect(normalizeName('🏠-𝐌𝐚𝐢𝐧-𝐂𝐡𝐚𝐭')).toBe('main-chat');
    expect(normalizeName('# Café Talk ')).toBe('cafe-talk');
  });

  it('records exact response token usage for dashboard cost accounting', async () => {
    const usageRecorder = { recordModelUsage: vi.fn(async () => undefined) };
    const { brain } = mockBrain([{
      status: 'completed', output: [], output_text: 'Counted.', _request_id: 'req-usage',
      usage: {
        input_tokens: 1200, output_tokens: 80,
        input_tokens_details: { cached_tokens: 400 },
        output_tokens_details: { reasoning_tokens: 30 },
      },
    }], vi.fn(), usageRecorder);
    await brain.takeVerificationTurn({ scene: scene(), instructions: 'Reply.', firstToolChoice: 'none', maxRounds: 1 });
    expect(usageRecorder.recordModelUsage).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-usage', model: 'gpt-5.4-mini', inputTokens: 1200,
      cachedInputTokens: 400, outputTokens: 80, reasoningTokens: 30,
    }));
  });

  it('returns a normal conversational response without requiring a tool', async () => {
    const { brain, create } = mockBrain([{
      status: 'completed', output: [], output_text: 'Alex, I was listening. Try not to look so surprised.', _request_id: 'req-chat',
    }]);
    const result = await brain.takeVerificationTurn({
      scene: scene(), instructions: 'Reply normally.', firstToolChoice: 'none', maxRounds: 1,
    });
    expect(result.silent).toBe(false);
    expect(result.text).toContain('Alex');
    expect(result.requestIds).toEqual(['req-chat']);
    expect(create).toHaveBeenCalledOnce();
  });

  it('parses a silence call and avoids a second model request', async () => {
    const execute = vi.fn(async () => ({ ok: true, summary: 'Cinder stayed silent.' }));
    const { brain, create } = mockBrain([
      {
        status: 'completed', output_text: '', _request_id: 'req-tool-1',
        output: [{ type: 'function_call', name: 'stay_silent', call_id: 'call-1', arguments: '{"reason":"humans are talking"}' }],
      },
    ], execute);
    const result = await brain.takeVerificationTurn({ scene: scene(), instructions: 'Use silence.', maxRounds: 2 });
    expect(result.silent).toBe(true);
    expect(result.text).toBe('');
    expect(result.toolCalls).toBe(1);
    expect(execute).toHaveBeenCalledWith(
      'stay_silent',
      { reason: 'humans are talking' },
      expect.objectContaining({ currentEvent: expect.objectContaining({ id: 'event:discord_text' }) }),
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it('waits and retries a 429 instead of failing the turn', async () => {
    vi.useFakeTimers();
    try {
      const { brain, create } = mockBrain([
        { status: 'completed', output: [], output_text: 'Recovered.', _request_id: 'req-after-limit' },
      ]);
      create.mockRejectedValueOnce(Object.assign(new Error('Please try again in 0.001s.'), { status: 429 }));
      const pending = brain.takeVerificationTurn({ scene: scene(), instructions: 'Reply.', firstToolChoice: 'none', maxRounds: 1 });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.text).toBe('Recovered.');
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('strict real tool schemas', () => {
  it('marks every object property required and optional values nullable', () => {
    const registry = new ToolRegistry(
      { recordAction: async () => undefined } as never,
      config,
      logger,
      {} as never,
    );
    expect(() => registry.assertSchemasValid()).not.toThrow();
    const createChannel = registry.definitions().find((tool) => tool.name === 'discord_create_channel');
    expect(createChannel).toBeTruthy();
    const parameters = createChannel?.parameters as {
      properties: Record<string, { type: string | string[] }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.required.sort()).toEqual(Object.keys(parameters.properties).sort());
    expect(parameters.properties.topic?.type).toEqual(['string', 'null']);
  });

  it('executes a harmless moderator-requested administration tool with the same registry', async () => {
    const createChannel = vi.fn(async () => ({ ok: true, summary: 'Created.', data: { channelId: 'new-channel' } }));
    const registry = new ToolRegistry(
      { recordAction: async () => undefined } as never,
      config,
      logger,
      { createChannel } as never,
    );
    const result = await registry.execute('discord_create_channel', {
      name: 'cinder-check', kind: 'text', category_reference: null, topic: null,
    }, {
      currentEvent: scene().current,
      scene: scene(),
      cinderTurnId: 'turn-admin',
    });
    expect(result.ok).toBe(true);
    expect(createChannel).toHaveBeenCalledWith(expect.objectContaining({ name: 'cinder-check', kind: 'text' }));
  });
});
