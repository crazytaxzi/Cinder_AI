import { z } from 'zod';
import type { Scene, ToolExecutionContext, ToolExecutionResult } from '@cinder/shared';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { Database } from '../db/database.js';
import {
  applyVoiceSettings,
  calculateVoiceSettings,
  persistVoiceSettings,
  readVoiceSettings,
  VOICE_SETTING_MAX,
  VOICE_SETTING_MIN,
  type VoiceSettings,
} from '../voice/settings.js';
import type { BridgeToolPort, DiscordToolPort, TwitchToolPort } from './ports.js';
import { ToolRegistry } from './registry.js';

const CONFIGURE_VOICE_TOOL = 'configure_voice';

const configureVoiceDefinition: ReturnType<ToolRegistry['definitions']>[number] = {
  type: 'function',
  name: CONFIGURE_VOICE_TOOL,
  description: 'Change Cinder’s live speech rate or pitch immediately, report the current values, or reset them. Use only when Senti personally asks. This never requires a restart or approval flow.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      speed: {
        type: ['number', 'null'],
        minimum: VOICE_SETTING_MIN,
        maximum: VOICE_SETTING_MAX,
        description: 'Absolute speech-rate multiplier. Use null when the request is relative or does not change speed.',
      },
      pitch: {
        type: ['number', 'null'],
        minimum: VOICE_SETTING_MIN,
        maximum: VOICE_SETTING_MAX,
        description: 'Absolute pitch multiplier. Use null when the request is relative or does not change pitch.',
      },
      speed_percent_change: {
        type: ['number', 'null'],
        minimum: -75,
        maximum: 300,
        description: 'Relative speech-rate change in percent. Positive is faster and negative is slower.',
      },
      pitch_percent_change: {
        type: ['number', 'null'],
        minimum: -75,
        maximum: 300,
        description: 'Relative pitch change in percent. Positive is higher and negative is lower.',
      },
      reset: {
        type: ['boolean', 'null'],
        description: 'True to restore Cinder’s configured startup voice. Reset ignores the other change fields.',
      },
      report_only: {
        type: ['boolean', 'null'],
        description: 'True to report the current live values without changing them.',
      },
    },
    required: [
      'speed',
      'pitch',
      'speed_percent_change',
      'pitch_percent_change',
      'reset',
      'report_only',
    ],
    additionalProperties: false,
  },
};

function usesAutomaticTwitchDelivery(scene: Scene): boolean {
  return scene.current.platform === 'twitch_chat' || scene.current.platform === 'twitch_event';
}

/**
 * Keeps platform delivery tools available for cross-platform actions without
 * exposing a second delivery path inside the room that triggered the turn.
 * It also gives Cinder an owner-only live control for his existing voice
 * transformation settings.
 */
export class PlatformAwareToolRegistry extends ToolRegistry {
  private readonly defaultVoiceSettings: VoiceSettings;

  constructor(
    private readonly voiceDatabase: Database,
    private readonly voiceConfig: Config,
    private readonly voiceLogger: Logger,
    discord: DiscordToolPort,
    twitch?: TwitchToolPort,
    bridge?: BridgeToolPort,
  ) {
    super(voiceDatabase, voiceConfig, voiceLogger, discord, twitch, bridge);
    this.defaultVoiceSettings = readVoiceSettings(voiceConfig);
  }

  override definitions(): ReturnType<ToolRegistry['definitions']> {
    return this.withVoiceTool(super.definitions());
  }

  override definitionsForScene(scene: Scene): ReturnType<ToolRegistry['definitionsForScene']> {
    const definitions = super.definitionsForScene(scene);
    const platformAware = usesAutomaticTwitchDelivery(scene)
      ? definitions.filter((definition) => definition.name !== 'twitch_send_message')
      : definitions;
    return this.withVoiceTool(platformAware);
  }

  override toolNames(): string[] {
    const names = super.toolNames();
    return names.includes(CONFIGURE_VOICE_TOOL) ? names : [...names, CONFIGURE_VOICE_TOOL];
  }

  override assertSchemasValid(): void {
    super.assertSchemasValid();
    const parameters = configureVoiceDefinition.parameters as {
      required?: unknown[];
      properties?: Record<string, unknown>;
      additionalProperties?: unknown;
    };
    if (parameters.additionalProperties !== false
      || !Array.isArray(parameters.required)
      || parameters.required.length !== Object.keys(parameters.properties ?? {}).length) {
      throw new Error('Invalid strict OpenAI tool schema: configure_voice');
    }
  }

  override async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (name !== CONFIGURE_VOICE_TOOL) return super.execute(name, args, context);

    let result: ToolExecutionResult;
    try {
      result = await this.configureVoice(args, context);
    } catch (error) {
      this.voiceLogger.error({ err: error, tool: name, args }, 'Cinder live voice configuration crashed');
      result = {
        ok: false,
        summary: error instanceof Error ? error.message : String(error),
        errorCode: 'TOOL_EXECUTION_ERROR',
        retryable: false,
      };
    }

    await this.voiceDatabase.recordAction({
      turnId: context.cinderTurnId,
      eventId: context.currentEvent.id,
      ...(context.currentEvent.serverId ? { serverId: context.currentEvent.serverId } : {}),
      actorPlatformUserId: context.currentEvent.actor.platformUserId,
      toolName: name,
      toolArguments: args,
      result,
    });

    return result;
  }

  private withVoiceTool(
    definitions: ReturnType<ToolRegistry['definitions']>,
  ): ReturnType<ToolRegistry['definitions']> {
    return definitions.some((definition) => definition.name === CONFIGURE_VOICE_TOOL)
      ? definitions
      : [...definitions, structuredClone(configureVoiceDefinition)];
  }

  private async configureVoice(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!await this.isVoiceOwner(context)) {
      return {
        ok: false,
        summary: 'Only Senti can choose Cinder’s pitch or speech rate.',
        errorCode: 'NOT_AUTHORIZED',
      };
    }

    const current = readVoiceSettings(this.voiceConfig);
    if (args.report_only === true) return this.voiceSettingsResult(current, false);

    const speed = typeof args.speed === 'number'
      ? z.number().min(VOICE_SETTING_MIN).max(VOICE_SETTING_MAX).parse(args.speed)
      : undefined;
    const pitch = typeof args.pitch === 'number'
      ? z.number().min(VOICE_SETTING_MIN).max(VOICE_SETTING_MAX).parse(args.pitch)
      : undefined;
    const speedPercentChange = typeof args.speed_percent_change === 'number'
      ? z.number().min(-75).max(300).parse(args.speed_percent_change)
      : undefined;
    const pitchPercentChange = typeof args.pitch_percent_change === 'number'
      ? z.number().min(-75).max(300).parse(args.pitch_percent_change)
      : undefined;
    const reset = args.reset === true;
    const hasChange = reset
      || speed !== undefined
      || pitch !== undefined
      || speedPercentChange !== undefined
      || pitchPercentChange !== undefined;

    if (!hasChange) return this.voiceSettingsResult(current, false);

    const next = calculateVoiceSettings(current, this.defaultVoiceSettings, {
      ...(speed !== undefined ? { speed } : {}),
      ...(pitch !== undefined ? { pitch } : {}),
      ...(speedPercentChange !== undefined ? { speedPercentChange } : {}),
      ...(pitchPercentChange !== undefined ? { pitchPercentChange } : {}),
      ...(reset ? { reset: true } : {}),
    });

    await persistVoiceSettings(this.voiceDatabase, next);
    applyVoiceSettings(this.voiceConfig, next);
    this.voiceLogger.info({
      actorId: context.currentEvent.actor.platformUserId,
      previous: current,
      current: next,
      reset,
    }, 'Cinder voice settings changed live');

    return this.voiceSettingsResult(next, true);
  }

  private async isVoiceOwner(context: ToolExecutionContext): Promise<boolean> {
    const actor = context.currentEvent.actor;
    const serverId = context.currentEvent.serverId ?? this.voiceConfig.DISCORD_GUILD_ID;
    const guildSettings = await this.voiceDatabase.getGuildConfiguration(serverId);
    const configuredOwnerId = guildSettings.ownerDiscordUserId ?? this.voiceConfig.CINDER_OWNER_DISCORD_ID;

    if (actor.platform === 'discord' && configuredOwnerId
      && actor.platformUserId === configuredOwnerId) return true;
    if (actor.platform === 'twitch' && this.voiceConfig.TWITCH_BROADCASTER_ID
      && actor.platformUserId === this.voiceConfig.TWITCH_BROADCASTER_ID) return true;
    if (actor.platform === 'windows' && context.currentEvent.metadata.dashboard === true
      && actor.isGuildOwner === true) return true;

    return actor.isGuildOwner === true && serverId === this.voiceConfig.DISCORD_GUILD_ID;
  }

  private voiceSettingsResult(settings: VoiceSettings, changed: boolean): ToolExecutionResult {
    return {
      ok: true,
      summary: changed
        ? `Voice settings changed live: speech rate ${settings.speed}x, pitch ${settings.pitch}x.`
        : `Current live voice settings: speech rate ${settings.speed}x, pitch ${settings.pitch}x.`,
      data: {
        speed: settings.speed,
        pitch: settings.pitch,
        changed,
        restartRequired: false,
      },
    };
  }
}
