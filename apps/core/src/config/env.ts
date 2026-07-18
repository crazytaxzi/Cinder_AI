import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalBooleanString = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: optionalBooleanString,
  MIGRATIONS_DIR: z.string().default('migrations'),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
  OPENAI_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).default('none'),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  STARTUP_SELF_TEST: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  CINDER_VOICE_SOCIAL_MODEL: z.string().default('gpt-5.4-nano'),
  CINDER_SOCIAL_MODEL: z.string().default('gpt-5.4-nano'),
  CINDER_SOCIAL_CONTEXT_EVENT_LIMIT: z.coerce.number().int().min(2).max(30).default(10),
  CINDER_SOCIAL_MAX_REPLY_CHARACTERS: z.coerce.number().int().min(80).max(2000).default(500),
  CINDER_VOICE_CLOUD_TRANSCRIPTION: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  CINDER_VOICE_CLOUD_STT_USD_PER_MINUTE: z.coerce.number().min(0).max(1).default(0.003),
  CINDER_VOICE_CONTEXT_EVENT_LIMIT: z.coerce.number().int().min(2).max(30).default(8),
  CINDER_VOICE_MAX_REPLY_CHARACTERS: z.coerce.number().int().min(80).max(1000).default(220),
  CINDER_VOICE_SPEECH_END_MS: z.coerce.number().int().min(250).max(2000).default(550),
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  OPENAI_TTS_VOICE: z.string().default('ash'),
  OPENAI_TTS_INSTRUCTIONS: z.string().default('A small mischievous imp with a lightly gravelly, raspy texture: smug, playful, crisp, and expressive. Keep the rasp subtle so every word stays clear. Never sound corporate.'),
  CINDER_VOICE_SPEED: z.coerce.number().min(0.25).max(2).default(0.462),
  CINDER_VOICE_PITCH: z.coerce.number().min(0.5).max(2).default(0.85896448),
  LOCAL_PIPER_PYTHON: z.string().default('/opt/cinder/local-voice/piper-venv/bin/python'),
  LOCAL_PIPER_MODEL: z.string().default('/opt/cinder/local-voice/models/en_US-ryan-medium.onnx'),
  LOCAL_PIPER_WORKER: z.string().default('scripts/piper-worker.py'),
  LOCAL_WHISPER_BINARY: z.string().default('/opt/cinder/local-voice/whisper.cpp/build/bin/whisper-cli'),
  LOCAL_WHISPER_MODEL: z.string().default('/opt/cinder/local-voice/models/ggml-tiny.en.bin'),
  LOCAL_WHISPER_THREADS: z.coerce.number().int().min(1).max(16).default(2),

  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  CINDER_OWNER_DISCORD_ID: z.string().optional(),
  DEFAULT_MODERATOR_ROLE_NAME: z.string().default('Moderator'),
  DEFAULT_VOICE_JOIN_ROLE_NAME: z.string().default('Moderator'),
  DISCORD_VOICE_IDLE_MINUTES: z.coerce.number().int().min(1).max(240).default(20),
  DISCORD_VOICE_MAX_UTTERANCE_SECONDS: z.coerce.number().int().min(5).max(120).default(45),
  DISCORD_VOICE_SILENCE_PADDING_FRAMES: z.coerce.number().int().min(5).max(50).default(20),
  DISCORD_VOICE_BARGE_IN_GRACE_MS: z.coerce.number().int().min(0).max(3000).default(450),

  TWITCH_ENABLED: booleanString,
  TWITCH_CLIENT_ID: z.string().optional(),
  TWITCH_CLIENT_SECRET: z.string().optional(),
  TWITCH_BOT_ACCESS_TOKEN: z.string().optional(),
  TWITCH_BOT_REFRESH_TOKEN: z.string().optional(),
  TWITCH_BOT_USER_ID: z.string().optional(),
  TWITCH_BROADCASTER_ACCESS_TOKEN: z.string().optional(),
  TWITCH_BROADCASTER_REFRESH_TOKEN: z.string().optional(),
  TWITCH_BROADCASTER_ID: z.string().optional(),
  TWITCH_CHAT_BATCH_MS: z.coerce.number().int().min(100).max(10000).default(1200),
  TWITCH_MAX_BATCH_MESSAGES: z.coerce.number().int().min(1).max(100).default(25),

  BRIDGE_ENABLED: booleanString,
  BRIDGE_TOKEN: z.string().optional(),
  BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  BRIDGE_COMMAND_TTL_SECONDS: z.coerce.number().int().min(5).max(3600).default(90),

  SCENE_RECENT_EVENT_LIMIT: z.coerce.number().int().min(5).max(100).default(12),
  SCENE_MEMORY_LIMIT: z.coerce.number().int().min(1).max(100).default(8),
  SCENE_RECENT_ACTION_LIMIT: z.coerce.number().int().min(0).max(100).default(8),
  CINDER_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(20).default(3),
  CINDER_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(8000).default(600),
  CINDER_MAX_REPLY_CHARACTERS: z.coerce.number().int().min(200).max(12000).default(900),
  CINDER_PROFILE_PATH: z.string().default('config/cinder-profile.md'),
  DASHBOARD_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  DASHBOARD_ADMIN_PASSWORD_HASH: z.string().min(20),
  DASHBOARD_SESSION_SECRET: z.string().min(32),
  DASHBOARD_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  CINDER_INTERNAL_CONTROL_TOKEN: z.string().min(32),
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  ACTION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
  EXTERNAL_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid Cinder configuration:\n${message}`);
  }

  const config = parsed.data;

  if (config.TWITCH_ENABLED) {
    const required = [
      ['TWITCH_CLIENT_ID', config.TWITCH_CLIENT_ID],
      ['TWITCH_CLIENT_SECRET', config.TWITCH_CLIENT_SECRET],
      ['TWITCH_BOT_ACCESS_TOKEN', config.TWITCH_BOT_ACCESS_TOKEN],
      ['TWITCH_BOT_REFRESH_TOKEN', config.TWITCH_BOT_REFRESH_TOKEN],
      ['TWITCH_BOT_USER_ID', config.TWITCH_BOT_USER_ID],
      ['TWITCH_BROADCASTER_ACCESS_TOKEN', config.TWITCH_BROADCASTER_ACCESS_TOKEN],
      ['TWITCH_BROADCASTER_REFRESH_TOKEN', config.TWITCH_BROADCASTER_REFRESH_TOKEN],
      ['TWITCH_BROADCASTER_ID', config.TWITCH_BROADCASTER_ID],
    ] as const;
    const missing = required.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`TWITCH_ENABLED=true but these values are missing: ${missing.join(', ')}`);
    }
  }

  if (config.BRIDGE_ENABLED && !config.BRIDGE_TOKEN) {
    throw new Error('BRIDGE_ENABLED=true but BRIDGE_TOKEN is missing.');
  }

  return config;
}
