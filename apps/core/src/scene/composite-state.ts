import type { EventEnvelope } from '@cinder/shared';
import type { DiscordAdapter } from '../adapters/discord.js';
import type { TwitchAdapter } from '../adapters/twitch.js';
import type { BridgeServer } from '../adapters/bridge-server.js';
import type { SceneStateProvider } from './assembler.js';

export class CompositeStateProvider implements SceneStateProvider {
  constructor(
    private readonly discord: DiscordAdapter,
    private readonly twitch?: TwitchAdapter,
    private readonly bridge?: BridgeServer,
  ) {}

  async getServerSnapshot(event: EventEnvelope): Promise<Record<string, unknown> | undefined> {
    if (event.platform === 'discord_text' || event.platform === 'discord_voice') {
      return this.discord.getServerSnapshot(event);
    }
    return undefined;
  }

  async getPlatformState(event: EventEnvelope): Promise<Record<string, unknown> | undefined> {
    const bridgeState = this.bridge?.getState();
    if (event.platform === 'twitch_chat' || event.platform === 'twitch_event') {
      return {
        ...(await this.twitch?.getPlatformState()),
        windowsBridge: bridgeState,
      };
    }
    if (event.platform === 'discord_text' || event.platform === 'discord_voice') {
      return {
        ...(await this.discord.getPlatformState(event)),
        twitchConnected: this.twitch?.isReady() ?? false,
        windowsBridge: bridgeState,
      };
    }
    return { windowsBridge: bridgeState };
  }

  getActiveVoiceParticipants(serverId?: string) {
    return this.discord.getActiveVoiceParticipants(serverId);
  }
}
