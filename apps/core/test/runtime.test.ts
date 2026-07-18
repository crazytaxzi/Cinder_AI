import { describe, expect, it } from 'vitest';
import type { EventEnvelope, Scene } from '@cinder/shared';
import { loadConfig } from '../src/config/env.js';
import { CinderRuntime } from '../src/cinder/runtime.js';
import { TurnQueue } from '../src/cinder/turn-queue.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://test', OPENAI_API_KEY: 'x', DISCORD_TOKEN: 'x',
  DISCORD_APPLICATION_ID: '1', DISCORD_GUILD_ID: '2',
  DASHBOARD_ADMIN_PASSWORD_HASH: 'scrypt-test-dashboard-password-hash',
  DASHBOARD_SESSION_SECRET: 'session-secret-session-secret-session-secret-session-secret',
  CINDER_INTERNAL_CONTROL_TOKEN: 'control-token-control-token-control-token-control-token',
});
const logger = { debug: () => undefined, error: () => undefined } as never;

function event(id = 'discord-message:1'): EventEnvelope {
  return {
    id, platform: 'discord_text', occurredAt: new Date().toISOString(),
    serverId: 'guild', channelId: 'channel', channelName: 'general',
    actor: { platform: 'discord', platformUserId: 'user', displayName: 'Alex', roles: [], isBot: false },
    text: 'Question', mentions: [], attachments: [], metadata: { messageId: id.split(':').at(-1) },
  };
}

describe('CinderRuntime', () => {
  it('delivers and stores Cinder’s own successful response for continuity', async () => {
    const stored: EventEnvelope[] = [];
    const delivered: string[] = [];
    const database = {
      storeEvent: async (item: EventEnvelope) => { stored.push(item); return true; },
      getGuildConfiguration: async () => ({ quietChannelIds: [], memoryExcludedChannelIds: [] }),
    };
    const assembler = { assemble: async (current: EventEnvelope) => ({ current } as Scene) };
    const brain = { takeSocialTurn: async () => ({ turnId: 'turn', text: 'A response.', silent: false, toolCalls: 0 }) };
    const discord = { deliver: async (_event: EventEnvelope, text: string) => { delivered.push(text); return { ok: true, summary: 'sent' }; } };
    const runtime = new CinderRuntime(config, logger, database as never, assembler as never, brain as never, new TurnQueue(logger), discord as never);
    await runtime.ingest(event());
    expect(delivered).toEqual(['A response.']);
    expect(stored).toHaveLength(2);
    expect(stored[1]?.id).toBe('cinder-response:turn');
    expect(stored[1]?.actor.displayName).toBe('Cinder');
  });

  it('deliberately stores the incoming scene but sends nothing for silence', async () => {
    let deliveries = 0;
    const database = {
      storeEvent: async () => true,
      getGuildConfiguration: async () => ({ quietChannelIds: [], memoryExcludedChannelIds: [] }),
    };
    const assembler = { assemble: async (current: EventEnvelope) => ({ current } as Scene) };
    const brain = { takeSocialTurn: async () => ({ turnId: 'turn', text: '', silent: true, toolCalls: 1 }) };
    const discord = { deliver: async () => { deliveries += 1; return { ok: true, summary: 'sent' }; } };
    const runtime = new CinderRuntime(config, logger, database as never, assembler as never, brain as never, new TurnQueue(logger), discord as never);
    await runtime.ingest(event());
    expect(deliveries).toBe(0);
  });

  it('does not retain or process explicitly quiet channels', async () => {
    let stored = 0;
    let turns = 0;
    const database = {
      storeEvent: async () => { stored += 1; return true; },
      getGuildConfiguration: async () => ({ quietChannelIds: ['channel'], memoryExcludedChannelIds: [] }),
    };
    const assembler = { assemble: async (current: EventEnvelope) => ({ current } as Scene) };
    const brain = { takeSocialTurn: async () => { turns += 1; return { turnId: 'turn', text: 'x', silent: false, toolCalls: 0 }; } };
    const discord = { deliver: async () => ({ ok: true, summary: 'sent' }) };
    const runtime = new CinderRuntime(config, logger, database as never, assembler as never, brain as never, new TurnQueue(logger), discord as never);
    await runtime.ingest(event());
    expect(stored).toBe(0);
    expect(turns).toBe(0);
  });

  it('uses in-memory context without database retention for memory-excluded channels', async () => {
    let stored = 0;
    let turn = 0;
    const seenRecent: string[][] = [];
    const database = {
      storeEvent: async () => { stored += 1; return true; },
      getGuildConfiguration: async () => ({ quietChannelIds: [], memoryExcludedChannelIds: ['channel'] }),
    };
    const assembler = {
      assemble: async (current: EventEnvelope, recent?: EventEnvelope[]) => {
        seenRecent.push((recent ?? []).map((item) => item.id));
        return { current, recentEvents: recent ?? [] } as Scene;
      },
    };
    const brain = { takeSocialTurn: async () => ({ turnId: `turn-${++turn}`, text: 'reply', silent: false, toolCalls: 0 }) };
    const discord = { deliver: async () => ({ ok: true, summary: 'sent' }) };
    const runtime = new CinderRuntime(config, logger, database as never, assembler as never, brain as never, new TurnQueue(logger), discord as never);
    await runtime.ingest(event());
    const second = event('discord-message:2');
    second.text = 'follow-up';
    await runtime.ingest(second);
    expect(stored).toBe(0);
    expect(seenRecent[0]).toEqual([]);
    expect(seenRecent[1]).toContain('discord-message:1');
    expect(seenRecent[1]?.some((id) => id.startsWith('cinder-response:'))).toBe(true);
  });
});

it('delivers a named Twitch chat response through the Twitch adapter', async () => {
  const delivered: string[] = [];
  const database = {
    storeEvent: async () => true,
    getGuildConfiguration: async () => ({ quietChannelIds: [], memoryExcludedChannelIds: [] }),
  };
  const twitchEvent: EventEnvelope = {
    ...event('twitch-message:1'),
    platform: 'twitch_chat',
    serverId: undefined,
    channelId: 'broadcaster',
    actor: { platform: 'twitch', platformUserId: 'pixel', displayName: 'Pixel', roles: [], isBot: false },
    text: 'Cinder, are you awake?',
  } as EventEnvelope;
  const assembler = { assemble: async (current: EventEnvelope) => ({ current } as Scene) };
  const brain = { takeSocialTurn: async () => ({ turnId: 'turn-twitch', text: 'Pixel, regrettably for both of us, yes.', silent: false, toolCalls: 0, requestIds: [] }) };
  const discord = { deliver: async () => ({ ok: false, summary: 'wrong adapter' }) };
  const twitch = { deliver: async (_event: EventEnvelope, text: string) => { delivered.push(text); return { ok: true, summary: 'sent' }; } };
  const runtime = new CinderRuntime(config, logger, database as never, assembler as never, brain as never, new TurnQueue(logger), discord as never, twitch as never);
  await runtime.ingest(twitchEvent);
  expect(delivered).toEqual(['Pixel, regrettably for both of us, yes.']);
});

it('retains ambient Twitch chat without invoking the brain or replying', async () => {
  let brainCalls = 0;
  let stored = 0;
  const database = {
    storeEvent: async () => { stored += 1; return true; },
    getGuildConfiguration: async () => ({ quietChannelIds: [], memoryExcludedChannelIds: [] }),
  };
  const twitchEvent = {
    ...event('twitch-message:ambient'),
    platform: 'twitch_chat',
    serverId: undefined,
    channelId: 'broadcaster',
    text: 'That boss fight was incredible!',
    metadata: { verified: true, directMention: false, replyToCinder: false, moderationCandidate: false },
  } as EventEnvelope;
  const brain = { takeTurn: async () => { brainCalls += 1; throw new Error('should not run'); } };
  const assembler = { assemble: async (current: EventEnvelope) => ({ current } as Scene) };
  const discord = { deliver: async () => ({ ok: false, summary: 'wrong adapter' }) };
  const twitch = { deliver: async () => ({ ok: true, summary: 'sent' }) };
  const runtime = new CinderRuntime(config, logger, database as never, assembler as never, brain as never, new TurnQueue(logger), discord as never, twitch as never);
  await runtime.ingest(twitchEvent);
  expect(stored).toBe(1);
  expect(brainCalls).toBe(0);
});
