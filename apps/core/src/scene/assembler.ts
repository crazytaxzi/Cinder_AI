import type {
  AudienceScope,
  EventEnvelope,
  Scene,
} from '@cinder/shared';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { Database } from '../db/database.js';

export interface SceneStateProvider {
  getServerSnapshot(event: EventEnvelope): Promise<Record<string, unknown> | undefined>;
  getPlatformState(event: EventEnvelope): Promise<Record<string, unknown> | undefined>;
  getActiveVoiceParticipants(serverId?: string): Array<{ userId: string; displayName: string; speaking: boolean }>;
}

function scopesForEvent(event: EventEnvelope, ownerId?: string, isModerator = false): AudienceScope[] {
  const scopes: AudienceScope[] = ['cross_platform_safe', 'temporary'];

  if (event.platform === 'twitch_chat' || event.platform === 'twitch_event') {
    scopes.push('twitch_public');
  } else if (event.platform === 'discord_voice') {
    scopes.push('discord_public', 'voice_session');
  } else if (event.platform === 'discord_text') {
    scopes.push('discord_public');
  }

  if (isModerator) scopes.push('moderator_private');
  if (ownerId && event.actor.platformUserId === ownerId) scopes.push('senti_private');

  return [...new Set(scopes)];
}

export class SceneAssembler {
  constructor(
    private readonly database: Database,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly stateProvider: SceneStateProvider,
  ) {}

  async assemble(event: EventEnvelope, recentOverride?: EventEnvelope[]): Promise<Scene> {
    const startedAt = Date.now();
    const [personId, guildConfiguration] = await Promise.all([
      this.database.ensureIdentity(event.actor),
      event.serverId
        ? this.database.getGuildConfiguration(event.serverId)
        : Promise.resolve(undefined),
    ]);
    event.actor.personId = personId;

    const moderatorRoleName = guildConfiguration?.moderatorRoleName?.toLocaleLowerCase();
    const isModerator = Boolean(
      moderatorRoleName
      && event.actor.roles.some((role) => role.toLocaleLowerCase() === moderatorRoleName),
    );

    const [recentEvents, relevantMemories, pendingApprovals, recentActions, serverSnapshot, platformState] = await Promise.all([
      recentOverride
        ? Promise.resolve(recentOverride)
        : this.database.recentEvents({
            ...(event.serverId ? { serverId: event.serverId } : {}),
            ...(event.channelId ? { channelId: event.channelId } : {}),
            limit: this.config.SCENE_RECENT_EVENT_LIMIT,
          }),
      this.database.getRelevantMemories({
        personId,
        ...(event.serverId ? { serverId: event.serverId } : {}),
        allowedScopes: scopesForEvent(event, guildConfiguration?.ownerDiscordUserId, isModerator),
        limit: this.config.SCENE_MEMORY_LIMIT,
      }),
      event.serverId ? this.database.getPendingApprovals(event.serverId) : Promise.resolve([]),
      event.serverId
        ? this.database.recentActions({ serverId: event.serverId, limit: this.config.SCENE_RECENT_ACTION_LIMIT })
        : Promise.resolve([]),
      this.stateProvider.getServerSnapshot(event),
      this.stateProvider.getPlatformState(event),
    ]);

    const scene: Scene = {
      current: event,
      recentEvents: recentEvents.filter((item) => item.id !== event.id),
      relevantMemories,
      pendingApprovals,
      recentActions,
      ...(guildConfiguration ? { guildConfiguration } : {}),
      activeVoiceParticipants: this.stateProvider.getActiveVoiceParticipants(event.serverId),
      ...(serverSnapshot ? { serverSnapshot } : {}),
      ...(platformState ? { platformState } : {}),
    };

    this.logger.debug(
      {
        eventId: event.id,
        platform: event.platform,
        recentEvents: recentEvents.length,
        memories: relevantMemories.length,
        approvals: pendingApprovals.length,
        elapsedMs: Date.now() - startedAt,
      },
      'Assembled Cinder scene',
    );

    return scene;
  }
}
