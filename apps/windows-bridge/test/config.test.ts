import { afterEach, describe, expect, it } from 'vitest';
import { loadBridgeConfig } from '../src/config.js';

const original = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, original);
});

describe('Windows bridge configuration', () => {
  it('parses song folders and allowlisted applications', () => {
    Object.assign(process.env, {
      CINDER_BRIDGE_URL: 'ws://127.0.0.1:3010',
      CINDER_BRIDGE_TOKEN: '1234567890123456',
      SONG_DIRECTORIES: 'C:\\Music;D:\\Songs',
      KNOWN_APPLICATIONS_JSON: '{"obs":"C:\\\\OBS\\\\obs64.exe"}',
    });
    const config = loadBridgeConfig();
    expect(config.songDirectories).toEqual(['C:\\Music', 'D:\\Songs']);
    expect(config.knownApplications.obs).toContain('OBS');
  });

  it('requires gcloud coordinates only when tunnel mode is enabled', () => {
    Object.assign(process.env, {
      CINDER_BRIDGE_TOKEN: '1234567890123456',
      CINDER_TUNNEL_MODE: 'gcloud',
    });
    expect(() => loadBridgeConfig()).toThrow(/CINDER_GCLOUD_PROJECT/);
  });
});
