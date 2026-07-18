import { describe, expect, it } from 'vitest';
import type { AudienceScope, EventEnvelope } from '@cinder/shared';
import { loadConfig } from '../src/config/env.js';
import { SceneAssembler } from '../src/scene/assembler.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://test', OPENAI_API_KEY: 'x', DISCORD_TOKEN: 'x',
  DISCORD_APPLICATION_ID: '1', DISCORD_GUILD_ID: '2',
  DASHBOARD_ADMIN_PASSWORD_HASH: 'scrypt-test-dashboard-password-hash',
  DASHBOARD_SESSION_SECRET: 'session-secret-session-secret-session-secret-session-secret',
  CINDER_INTERNAL_CONTROL_TOKEN: 'control-token-control-token-control-token-control-token',
});

function event(id = 'current'): EventEnvelope {
  return {
    id,
    platform: 'discord_text',
    occurredAt: new Date().toISOString(),
    serverId: 'guild',
    channelId: 'channel',
    actor: {
      platform: 'discord', platformUserId: 'user', displayName: 'Sera',
      roles: ['Moderator'], isBot: false,
    },
    text: 'Do the thing.', mentions: [], attachments: [], metadata: { verified: true },
  };
}

describe('SceneAssembler', () => {
  it('builds one verified scene without duplicating the current event', async () => {
    let allowedScopes: AudienceScope[] = [];
    const database = {
      ensureIdentity: async () => 'person',
      getGuildConfiguration: async () => ({
        serverId: 'guild', moderatorRoleName: 'Moderator', ownerDiscordUserId: 'owner',
        quietChannelIds: [], memoryExcludedChannelIds: [],
      }),
      recentEvents: async () => [event('previous'), event('current')],
      getRelevantMemories: async (input: { allowedScopes: AudienceScope[] }) => {
        allowedScopes = input.allowedScopes;
        return [];
      },
      getPendingApprovals: async () => [],
      recentActions: async () => [],
    };
    const state = {
      getServerSnapshot: async () => ({ verified: true }),
      getPlatformState: async () => ({ connected: true }),
      getActiveVoiceParticipants: () => [],
    };
    const assembler = new SceneAssembler(database as never, config, { debug: () => undefined } as never, state);
    const scene = await assembler.assemble(event());
    expect(scene.current.actor.personId).toBe('person');
    expect(scene.recentEvents.map((item) => item.id)).toEqual(['previous']);
    expect(scene.serverSnapshot).toEqual({ verified: true });
    expect(allowedScopes).toContain('moderator_private');
    expect(allowedScopes).toContain('discord_public');
  });
});
