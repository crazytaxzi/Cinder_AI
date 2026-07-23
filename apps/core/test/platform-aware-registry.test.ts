import { describe, expect, it } from 'vitest';
import type { EventEnvelope, Scene } from '@cinder/shared';
import { loadConfig } from '../src/config/env.js';
import { PlatformAwareToolRegistry } from '../src/tools/platform-aware-registry.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://test',
  OPENAI_API_KEY: 'x',
  DISCORD_TOKEN: 'x',
  DISCORD_APPLICATION_ID: '1',
  DISCORD_GUILD_ID: '2',
  DASHBOARD_ADMIN_PASSWORD_HASH: 'scrypt-test-dashboard-password-hash',
  DASHBOARD_SESSION_SECRET: 'session-secret-session-secret-session-secret-session-secret',
  CINDER_INTERNAL_CONTROL_TOKEN: 'control-token-control-token-control-token-control-token',
  TWITCH_ENABLED: 'true',
  TWITCH_CLIENT_ID: 'client',
  TWITCH_CLIENT_SECRET: 'secret',
  TWITCH_BOT_ACCESS_TOKEN: 'bot-access',
  TWITCH_BOT_REFRESH_TOKEN: 'bot-refresh',
  TWITCH_BOT_USER_ID: 'bot-user',
  TWITCH_BROADCASTER_ACCESS_TOKEN: 'broadcaster-access',
  TWITCH_BROADCASTER_REFRESH_TOKEN: 'broadcaster-refresh',
  TWITCH_BROADCASTER_ID: 'broadcaster',
});

function makeScene(platform: EventEnvelope['platform']): Scene {
  return {
    current: {
      id: `${platform}:event`,
      platform,
      occurredAt: new Date().toISOString(),
      ...(platform.startsWith('discord') ? { serverId: 'guild' } : {}),
      channelId: platform.startsWith('twitch') ? 'broadcaster' : 'general',
      actor: {
        platform: platform.startsWith('twitch') ? 'twitch' : 'discord',
        platformUserId: 'user',
        displayName: 'Senti',
        roles: [],
        isBot: false,
      },
      text: 'Cinder, you here too?',
      mentions: [],
      attachments: [],
      metadata: { verified: true, directMention: true },
    },
    recentEvents: [],
    relevantMemories: [],
    pendingApprovals: [],
    recentActions: [],
    activeVoiceParticipants: [],
  } as Scene;
}

describe('PlatformAwareToolRegistry', () => {
  it('hides the duplicate Twitch send path from turns already in Twitch', () => {
    const tools = new PlatformAwareToolRegistry(
      { recordAction: async () => undefined } as never,
      config,
      { error: () => undefined } as never,
      {} as never,
      {} as never,
    );

    expect(tools.definitions().map((tool) => tool.name)).toContain('twitch_send_message');
    expect(tools.definitionsForScene(makeScene('twitch_chat')).map((tool) => tool.name))
      .not.toContain('twitch_send_message');
    expect(tools.definitionsForScene(makeScene('twitch_event')).map((tool) => tool.name))
      .not.toContain('twitch_send_message');
  });

  it('keeps Twitch sending available for intentional cross-platform actions', () => {
    const tools = new PlatformAwareToolRegistry(
      { recordAction: async () => undefined } as never,
      config,
      { error: () => undefined } as never,
      {} as never,
      {} as never,
    );

    expect(tools.definitionsForScene(makeScene('discord_text')).map((tool) => tool.name))
      .toContain('twitch_send_message');
  });
});
