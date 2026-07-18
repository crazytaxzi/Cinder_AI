import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

const base = {
  DATABASE_URL: 'postgresql://test',
  OPENAI_API_KEY: 'openai-test',
  DISCORD_TOKEN: 'discord-test',
  DISCORD_APPLICATION_ID: '1',
  DISCORD_GUILD_ID: '2',
  DASHBOARD_ADMIN_PASSWORD_HASH: 'scrypt-test-dashboard-password-hash',
  DASHBOARD_SESSION_SECRET: 'session-secret-session-secret-session-secret-session-secret',
  CINDER_INTERNAL_CONTROL_TOKEN: 'control-token-control-token-control-token-control-token',
};

describe('loadConfig', () => {
  it('loads a Discord-only installation with safe defaults', () => {
    const config = loadConfig(base);
    expect(config.TWITCH_ENABLED).toBe(false);
    expect(config.OPENAI_MODEL).toBe('gpt-5.4-mini');
    expect(config.DEFAULT_MODERATOR_ROLE_NAME).toBe('Moderator');
    expect(config.DISCORD_VOICE_SILENCE_PADDING_FRAMES).toBe(20);
    expect(config.DISCORD_VOICE_BARGE_IN_GRACE_MS).toBe(450);
    expect(config.CINDER_MAX_TOOL_ROUNDS).toBe(3);
    expect(config.CINDER_MAX_OUTPUT_TOKENS).toBe(600);
    expect(config.CINDER_VOICE_SPEED).toBe(0.468);
    expect(config.CINDER_VOICE_PITCH).toBe(0.4981994);
    expect(config.OPENAI_TTS_INSTRUCTIONS).toContain('gravelly');
  });

  it('requires both Twitch identities when Twitch is enabled', () => {
    expect(() => loadConfig({ ...base, TWITCH_ENABLED: 'true' })).toThrow(/TWITCH_BOT_ACCESS_TOKEN/);
  });

  it('accepts complete dual-account Twitch configuration', () => {
    const config = loadConfig({
      ...base,
      TWITCH_ENABLED: 'true',
      TWITCH_CLIENT_ID: 'client',
      TWITCH_CLIENT_SECRET: 'secret',
      TWITCH_BOT_ACCESS_TOKEN: 'bot-access',
      TWITCH_BOT_REFRESH_TOKEN: 'bot-refresh',
      TWITCH_BOT_USER_ID: '10',
      TWITCH_BROADCASTER_ACCESS_TOKEN: 'broadcaster-access',
      TWITCH_BROADCASTER_REFRESH_TOKEN: 'broadcaster-refresh',
      TWITCH_BROADCASTER_ID: '20',
    });
    expect(config.TWITCH_ENABLED).toBe(true);
    expect(config.TWITCH_BOT_USER_ID).toBe('10');
    expect(config.TWITCH_BROADCASTER_ID).toBe('20');
  });

  it('requires a bridge token only when the bridge is enabled', () => {
    expect(() => loadConfig({ ...base, BRIDGE_ENABLED: 'true' })).toThrow(/BRIDGE_TOKEN/);
  });
});
