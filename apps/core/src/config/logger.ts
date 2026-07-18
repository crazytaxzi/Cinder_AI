import pino from 'pino';
import type { Config } from './env.js';

export function createLogger(config: Config) {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'cinder-core', version: '2.0.0-native' },
    redact: {
      paths: [
        'req.headers.authorization',
        'authorization',
        'token',
        '*.token',
        'apiKey',
        '*.apiKey',
        'password',
        '*.password',
        'OPENAI_API_KEY',
        'DISCORD_TOKEN',
        'TWITCH_BOT_ACCESS_TOKEN',
        'TWITCH_BROADCASTER_ACCESS_TOKEN',
        'TWITCH_BOT_REFRESH_TOKEN',
        'TWITCH_BROADCASTER_REFRESH_TOKEN',
        'BRIDGE_TOKEN',
      ],
      censor: '[REDACTED]',
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
