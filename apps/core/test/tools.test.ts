import { describe, expect, it } from 'vitest';
import type { EventEnvelope, Scene } from '@cinder/shared';
import { loadConfig } from '../src/config/env.js';
import { ToolRegistry } from '../src/tools/registry.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://test', OPENAI_API_KEY: 'x', DISCORD_TOKEN: 'x',
  DISCORD_APPLICATION_ID: '1', DISCORD_GUILD_ID: '2',
  DASHBOARD_ADMIN_PASSWORD_HASH: 'scrypt-test-dashboard-password-hash',
  DASHBOARD_SESSION_SECRET: 'session-secret-session-secret-session-secret-session-secret',
  CINDER_INTERNAL_CONTROL_TOKEN: 'control-token-control-token-control-token-control-token',
});

const current: EventEnvelope = {
  id: 'event', platform: 'discord_text', occurredAt: new Date().toISOString(),
  serverId: 'guild', channelId: 'general',
  actor: { platform: 'discord', platformUserId: 'mod', displayName: 'Sera', roles: ['Moderator'], isBot: false },
  text: 'Delete it after I approve.', mentions: [], attachments: [], metadata: {},
};
const scene = { current } as Scene;

describe('ToolRegistry', () => {
  it('exposes one set of hands including silence, Discord, memory, approvals, and configuration', () => {
    const tools = new ToolRegistry({ recordAction: async () => undefined } as never, config, { error: () => undefined } as never, {} as never);
    const names = tools.definitions().map((tool) => tool.name);
    expect(names).toContain('stay_silent');
    expect(names).toContain('discord_create_channel');
    expect(names).toContain('discord_index_messages');
    expect(names).toContain('discord_find_user_messages');
    expect(names).toContain('discord_search_indexed_messages');
    expect(names).toContain('remember');
    expect(names).toContain('configure_cinder');
    expect(names).toContain('request_approval');
  });

  it('gives an escalated voice turn real action tools while gating voice connection controls', () => {
    const tools = new ToolRegistry({ recordAction: async () => undefined } as never, config, { error: () => undefined } as never, {} as never);
    const voiceScene = {
      ...scene,
      current: { ...current, platform: 'discord_voice', text: 'Give HighwayHero the Verified role.', metadata: { verified: true } },
    } as Scene;
    const names = tools.definitionsForScene(voiceScene).map((tool) => tool.name);
    expect(names).toContain('discord_assign_role');
    expect(names).toContain('discord_create_channel');
    expect(names).not.toContain('discord_join_voice');
    expect(names).not.toContain('discord_leave_voice');
  });

  it('keeps approval IDs internal instead of making humans copy them', async () => {
    let sent = '';
    const database = {
      recordAction: async () => undefined,
      getGuildConfiguration: async () => ({
        serverId: 'guild', moderatorRoleName: 'Moderator', botAdminChannelId: 'admin',
        quietChannelIds: [], memoryExcludedChannelIds: [],
      }),
      createApproval: async () => ({
        id: 'hidden-approval-id', serverId: 'guild', requestedByPlatformUserId: 'mod',
        requestedByName: 'Sera', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
        description: 'Delete the category', toolName: 'discord_delete_channel',
        toolArguments: { channel_reference: 'old' }, originChannelId: 'general', approvalChannelId: 'admin',
      }),
    };
    const discord = {
      sendMessage: async (input: { text: string }) => { sent = input.text; return { ok: true, summary: 'sent' }; },
    };
    const tools = new ToolRegistry(database as never, config, { error: () => undefined } as never, discord as never);
    const result = await tools.execute('request_approval', {
      description: 'Delete the category',
      tool_name: 'discord_delete_channel',
      tool_arguments_json: '{"channel_reference":"old"}',
      ttl_minutes: 10,
    }, { currentEvent: current, scene, cinderTurnId: 'turn' });
    expect(result.ok).toBe(true);
    expect(sent).toContain('Approval needed: Delete the category');
    expect(sent).not.toContain('hidden-approval-id');
    expect(sent).not.toContain('Approval reference');
  });

  it('blocks discord_send_message to the current channel to prevent duplicate replies', async () => {
    let sends = 0;
    const database = { recordAction: async () => undefined };
    const discord = {
      resolveChannelId: async () => 'general',
      sendMessage: async () => {
        sends += 1;
        return { ok: true, summary: 'sent' };
      },
    };
    const tools = new ToolRegistry(database as never, config, { error: () => undefined } as never, discord as never);
    const result = await tools.execute('discord_send_message', {
      channel_reference: 'discord:channel:general',
      text: 'This must be returned normally instead.',
      reply_to_message_reference: null,
    }, { currentEvent: current, scene, cinderTurnId: 'turn-send' });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('CURRENT_CHANNEL_AUTO_DELIVERY');
    expect(sends).toBe(0);
  });

  it('resolves and indexes messages for one Discord user in one channel', async () => {
    const message = {
      ...current,
      id: 'discord-message:123456789012345',
      channelId: 'main',
      channelName: '🏠-𝐌𝐚𝐢𝐧-𝐂𝐡𝐚𝐭',
      actor: { ...current.actor, platformUserId: 'user-1', displayName: 'Gaia', username: 'gaiaalpha' },
      text: 'A message worth finding',
      metadata: { messageId: '123456789012345', messageRef: 'discord:message:123456789012345', channelRef: 'discord:channel:main' },
    };
    const database = {
      recordAction: async () => undefined,
      getGuildConfiguration: async () => ({
        serverId: 'guild', moderatorRoleName: 'Moderator', quietChannelIds: [], memoryExcludedChannelIds: [],
      }),
      storeEvent: async () => true,
    };
    const findMessagesByUser = async () => ({
      events: [message], scanned: 350, channelId: 'main', channelName: '🏠-𝐌𝐚𝐢𝐧-𝐂𝐡𝐚𝐭',
      userId: 'user-1', userName: 'Gaia',
    });
    const tools = new ToolRegistry(database as never, config, { error: () => undefined } as never, { findMessagesByUser } as never);
    const result = await tools.execute('discord_find_user_messages', {
      channel_reference: 'main-chat', user_reference: 'Gaia', query: null, scan_limit: 500, result_limit: 25,
    }, { currentEvent: current, scene, cinderTurnId: 'turn-find' });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('scanned 350 messages');
    expect(result.data).toEqual(expect.objectContaining({ userRef: 'discord:user:user-1' }));
  });
});
