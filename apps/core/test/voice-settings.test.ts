import { describe, expect, it, vi } from 'vitest';
import type { Scene, ToolExecutionContext } from '@cinder/shared';
import { loadConfig } from '../src/config/env.js';
import { PlatformAwareToolRegistry } from '../src/tools/platform-aware-registry.js';
import {
  calculateVoiceSettings,
  restorePersistedVoiceSettings,
  VOICE_SETTINGS_STATE_KEY,
} from '../src/voice/settings.js';

function makeConfig() {
  return loadConfig({
    DATABASE_URL: 'postgresql://test',
    OPENAI_API_KEY: 'x',
    DISCORD_TOKEN: 'x',
    DISCORD_APPLICATION_ID: '1',
    DISCORD_GUILD_ID: 'guild',
    CINDER_OWNER_DISCORD_ID: 'owner',
    DASHBOARD_ADMIN_PASSWORD_HASH: 'scrypt-test-dashboard-password-hash',
    DASHBOARD_SESSION_SECRET: 'session-secret-session-secret-session-secret-session-secret',
    CINDER_INTERNAL_CONTROL_TOKEN: 'control-token-control-token-control-token-control-token',
  });
}

function makeContext(userId: string, isGuildOwner = false): ToolExecutionContext {
  const scene = {
    current: {
      id: `voice:${userId}`,
      platform: 'discord_voice',
      occurredAt: new Date().toISOString(),
      serverId: 'guild',
      channelId: 'voice',
      voiceChannelId: 'voice',
      actor: {
        platform: 'discord',
        platformUserId: userId,
        displayName: userId,
        roles: [],
        isBot: false,
        isGuildOwner,
      },
      text: 'Cinder, speak faster and lower your pitch.',
      mentions: [],
      attachments: [],
      metadata: { verified: true },
    },
    recentEvents: [],
    relevantMemories: [],
    pendingApprovals: [],
    recentActions: [],
    activeVoiceParticipants: [],
  } as Scene;
  return { currentEvent: scene.current, scene, cinderTurnId: `turn:${userId}` };
}

describe('live Cinder voice settings', () => {
  it('calculates relative changes and reset without drifting', () => {
    const defaults = { speed: 0.468, pitch: 0.538055 };
    expect(calculateVoiceSettings(defaults, defaults, {
      speedPercentChange: 10,
      pitchPercentChange: -5,
    })).toEqual({ speed: 0.5148, pitch: 0.511152 });
    expect(calculateVoiceSettings({ speed: 0.8, pitch: 0.7 }, defaults, { reset: true }))
      .toEqual(defaults);
  });

  it('restores persisted values directly into the live config object', async () => {
    const config = makeConfig();
    const logger = { info: vi.fn(), warn: vi.fn() } as never;
    const store = {
      getRuntimeState: vi.fn(async () => ({ speed: 0.61, pitch: 0.49 })),
      setRuntimeState: vi.fn(async () => undefined),
    };

    await restorePersistedVoiceSettings(store, config, logger);

    expect(config.CINDER_VOICE_SPEED).toBe(0.61);
    expect(config.CINDER_VOICE_PITCH).toBe(0.49);
  });

  it('lets only Cinder’s owner change pitch and rate live', async () => {
    const config = makeConfig();
    const setRuntimeState = vi.fn(async () => undefined);
    const recordAction = vi.fn(async () => undefined);
    const database = {
      getGuildConfiguration: vi.fn(async () => ({
        serverId: 'guild',
        moderatorRoleName: 'Moderator',
        ownerDiscordUserId: 'owner',
        voiceJoinRoleName: 'Moderator',
        quietChannelIds: [],
        memoryExcludedChannelIds: [],
      })),
      setRuntimeState,
      recordAction,
    } as never;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const tools = new PlatformAwareToolRegistry(database, config, logger, {} as never);
    const args = {
      speed: null,
      pitch: null,
      speed_percent_change: 10,
      pitch_percent_change: -5,
      reset: false,
      report_only: false,
    };

    const denied = await tools.execute('configure_voice', args, makeContext('someone-else'));
    expect(denied).toMatchObject({ ok: false, errorCode: 'NOT_AUTHORIZED' });
    expect(setRuntimeState).not.toHaveBeenCalled();

    const changed = await tools.execute('configure_voice', args, makeContext('owner'));
    expect(changed).toMatchObject({ ok: true, data: { changed: true, restartRequired: false } });
    expect(config.CINDER_VOICE_SPEED).toBe(0.5148);
    expect(config.CINDER_VOICE_PITCH).toBe(0.511152);
    expect(setRuntimeState).toHaveBeenCalledWith(VOICE_SETTINGS_STATE_KEY, {
      speed: 0.5148,
      pitch: 0.511152,
    });
    expect(recordAction).toHaveBeenCalledTimes(2);
  });

  it('exposes the live voice tool to ordinary and voice turns', () => {
    const config = makeConfig();
    const database = { recordAction: async () => undefined } as never;
    const tools = new PlatformAwareToolRegistry(
      database,
      config,
      { error: () => undefined } as never,
      {} as never,
    );

    expect(tools.toolNames()).toContain('configure_voice');
    expect(tools.definitionsForScene(makeContext('owner').scene).map((tool) => tool.name))
      .toContain('configure_voice');
    expect(() => tools.assertSchemasValid()).not.toThrow();
  });
});