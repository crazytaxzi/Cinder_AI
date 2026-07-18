import { z } from 'zod';

const schema = z.object({
  CINDER_BRIDGE_URL: z.string().url().default('ws://127.0.0.1:3010'),
  CINDER_BRIDGE_TOKEN: z.string().min(16),
  CINDER_BRIDGE_ID: z.string().default('senti-windows'),
  CINDER_TUNNEL_MODE: z.enum(['none', 'gcloud']).default('none'),
  CINDER_GCLOUD_PROJECT: z.string().optional(),
  CINDER_GCLOUD_ZONE: z.string().optional(),
  CINDER_GCLOUD_INSTANCE: z.string().optional(),
  CINDER_GCLOUD_USER: z.string().optional(),
  CINDER_LOCAL_TUNNEL_PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  CINDER_REMOTE_BRIDGE_HOST: z.string().default('127.0.0.1'),
  CINDER_REMOTE_BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  SONG_DIRECTORIES: z.string().default(''),
  KNOWN_APPLICATIONS_JSON: z.string().default('{}'),
  OBS_WEBSOCKET_URL: z.string().default('ws://127.0.0.1:4455'),
  OBS_WEBSOCKET_PASSWORD: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
});

export type BridgeConfig = z.infer<typeof schema> & {
  songDirectories: string[];
  knownApplications: Record<string, string>;
};

export function loadBridgeConfig(): BridgeConfig {
  const parsed = schema.parse(process.env);
  let knownApplications: Record<string, string>;
  try {
    knownApplications = JSON.parse(parsed.KNOWN_APPLICATIONS_JSON) as Record<string, string>;
  } catch {
    throw new Error('KNOWN_APPLICATIONS_JSON must be a JSON object mapping friendly names to executable paths.');
  }

  if (parsed.CINDER_TUNNEL_MODE === 'gcloud') {
    const missing = [
      ['CINDER_GCLOUD_PROJECT', parsed.CINDER_GCLOUD_PROJECT],
      ['CINDER_GCLOUD_ZONE', parsed.CINDER_GCLOUD_ZONE],
      ['CINDER_GCLOUD_INSTANCE', parsed.CINDER_GCLOUD_INSTANCE],
      ['CINDER_GCLOUD_USER', parsed.CINDER_GCLOUD_USER],
    ].filter(([, value]) => !value).map(([key]) => key);
    if (missing.length > 0) throw new Error(`gcloud tunnel is enabled but these values are missing: ${missing.join(', ')}`);
  }

  return {
    ...parsed,
    songDirectories: parsed.SONG_DIRECTORIES.split(';').map((item) => item.trim()).filter(Boolean),
    knownApplications,
  };
}
