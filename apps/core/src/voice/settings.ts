import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';

export const VOICE_SETTINGS_STATE_KEY = 'cinder.voice.settings';
export const VOICE_SETTING_MIN = 0.25;
export const VOICE_SETTING_MAX = 2;

export interface VoiceSettings {
  speed: number;
  pitch: number;
}

export interface VoiceSettingsUpdate {
  speed?: number;
  pitch?: number;
  speedPercentChange?: number;
  pitchPercentChange?: number;
  reset?: boolean;
}

export interface VoiceSettingsStore {
  getRuntimeState<T extends Record<string, unknown>>(key: string): Promise<T | undefined>;
  setRuntimeState(key: string, value: Record<string, unknown>): Promise<void>;
}

function roundSetting(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function requireSetting(name: 'speed' | 'pitch', value: number): number {
  if (!Number.isFinite(value) || value < VOICE_SETTING_MIN || value > VOICE_SETTING_MAX) {
    throw new Error(`${name} must stay between ${VOICE_SETTING_MIN} and ${VOICE_SETTING_MAX}.`);
  }
  return roundSetting(value);
}

export function validateVoiceSettings(settings: VoiceSettings): VoiceSettings {
  return {
    speed: requireSetting('speed', settings.speed),
    pitch: requireSetting('pitch', settings.pitch),
  };
}

export function readVoiceSettings(config: Config): VoiceSettings {
  return validateVoiceSettings({
    speed: config.CINDER_VOICE_SPEED,
    pitch: config.CINDER_VOICE_PITCH,
  });
}

export function applyVoiceSettings(config: Config, settings: VoiceSettings): VoiceSettings {
  const validated = validateVoiceSettings(settings);
  config.CINDER_VOICE_SPEED = validated.speed;
  config.CINDER_VOICE_PITCH = validated.pitch;
  return validated;
}

export function calculateVoiceSettings(
  current: VoiceSettings,
  defaults: VoiceSettings,
  update: VoiceSettingsUpdate,
): VoiceSettings {
  if (update.reset === true) return validateVoiceSettings(defaults);

  let speed = update.speed ?? current.speed;
  let pitch = update.pitch ?? current.pitch;

  if (update.speedPercentChange !== undefined) {
    speed *= 1 + update.speedPercentChange / 100;
  }
  if (update.pitchPercentChange !== undefined) {
    pitch *= 1 + update.pitchPercentChange / 100;
  }

  return validateVoiceSettings({ speed, pitch });
}

export function parsePersistedVoiceSettings(value: unknown): VoiceSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.speed !== 'number' || typeof candidate.pitch !== 'number') return undefined;
  try {
    return validateVoiceSettings({ speed: candidate.speed, pitch: candidate.pitch });
  } catch {
    return undefined;
  }
}

export async function persistVoiceSettings(
  store: VoiceSettingsStore,
  settings: VoiceSettings,
): Promise<void> {
  const validated = validateVoiceSettings(settings);
  await store.setRuntimeState(VOICE_SETTINGS_STATE_KEY, {
    speed: validated.speed,
    pitch: validated.pitch,
  });
}

export async function restorePersistedVoiceSettings(
  store: VoiceSettingsStore,
  config: Config,
  logger: Logger,
): Promise<VoiceSettings | undefined> {
  try {
    const state = await store.getRuntimeState<Record<string, unknown>>(VOICE_SETTINGS_STATE_KEY);
    const settings = parsePersistedVoiceSettings(state);
    if (!settings) return undefined;
    applyVoiceSettings(config, settings);
    logger.info(settings, 'Restored live Cinder voice settings');
    return settings;
  } catch (error) {
    logger.warn({ err: error }, 'Could not restore live Cinder voice settings; using configured defaults');
    return undefined;
  }
}
