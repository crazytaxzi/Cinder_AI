import { randomUUID } from 'node:crypto';
import type { EventEnvelope, ToolExecutionResult } from '@cinder/shared';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { Database } from '../db/database.js';
import type { DiscordAdapter } from '../adapters/discord.js';
import type { TwitchAdapter } from '../adapters/twitch.js';
import type { SceneAssembler } from '../scene/assembler.js';
import { priorityForEvent } from './priorities.js';
import { CinderTurnError, type CinderBrain, type CinderTurnResult } from './brain.js';
import type { TurnQueue } from './turn-queue.js';

export interface RuntimeCommandResult extends CinderTurnResult {
  eventId: string;
  delivered: boolean;
}

export class CinderRuntime {
  private acceptingEvents = true;
  private paused = false;
  private pauseReason: string | undefined;
  private readonly ephemeralChannels = new Map<string, EventEnvelope[]>();
  private readonly ephemeralSeen = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly database: Database,
    private readonly assembler: SceneAssembler,
    private readonly brain: CinderBrain,
    private readonly queue: TurnQueue,
    private readonly discord: DiscordAdapter,
    private readonly twitch?: TwitchAdapter,
  ) {}

  async ingest(event: EventEnvelope): Promise<void> {
    if (!this.acceptingEvents || !event.text.trim()) return;
    if (this.paused) {
      this.logger.info({ eventId: event.id, reason: this.pauseReason }, 'Cinder ignored an event while paused');
      return;
    }
    await this.prepareAndQueue(event, true);
  }

  async runSyntheticEvent(event: EventEnvelope, deliverResponse = true): Promise<RuntimeCommandResult> {
    if (!this.acceptingEvents) throw new Error('Cinder is shutting down.');
    return this.prepareAndQueue(event, deliverResponse);
  }

  async runDashboardCommand(input: {
    text: string;
    channelId?: string;
    channelName?: string;
  }): Promise<RuntimeCommandResult> {
    if (!this.acceptingEvents) throw new Error('Cinder is shutting down.');
    const event: EventEnvelope = {
      id: `dashboard:${randomUUID()}`,
      platform: 'windows',
      occurredAt: new Date().toISOString(),
      serverId: this.config.DISCORD_GUILD_ID,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.channelName ? { channelName: input.channelName } : {}),
      actor: {
        platform: 'windows',
        platformUserId: this.config.CINDER_OWNER_DISCORD_ID ?? 'dashboard-owner',
        displayName: 'Senti via dashboard',
        roles: [this.config.DEFAULT_MODERATOR_ROLE_NAME],
        isBot: false,
        isGuildOwner: true,
      },
      text: input.text,
      mentions: [],
      attachments: [],
      metadata: {
        verified: true,
        dashboard: true,
        directMention: true,
      },
    };
    return this.prepareAndQueue(event, false);
  }

  pause(reason = 'Paused from the dashboard'): void {
    this.paused = true;
    this.pauseReason = reason;
    this.logger.warn({ reason }, 'Cinder cognitive processing paused');
  }

  resume(): void {
    this.paused = false;
    this.pauseReason = undefined;
    this.logger.info('Cinder cognitive processing resumed');
  }

  isPaused(): boolean {
    return this.paused;
  }

  getPauseReason(): string | undefined {
    return this.pauseReason;
  }

  stopAcceptingEvents(): void {
    this.acceptingEvents = false;
  }

  queueSize(): number {
    return this.queue.size();
  }

  private async prepareAndQueue(event: EventEnvelope, deliverResponse: boolean): Promise<RuntimeCommandResult> {
    let memoryExcluded = false;
    let ephemeralRecent: EventEnvelope[] | undefined;

    if (event.serverId && event.channelId) {
      const settings = await this.database.getGuildConfiguration(event.serverId);
      if ((settings.quietChannelIds ?? []).includes(event.channelId) && event.metadata.dashboard !== true) {
        this.logger.debug({ eventId: event.id, channelId: event.channelId }, 'Ignored explicitly quiet channel without retaining it');
        return {
          eventId: event.id,
          turnId: 'quiet-channel',
          text: '',
          silent: true,
          toolCalls: 0,
          requestIds: [],
          delivered: false,
        };
      }
      memoryExcluded = (settings.memoryExcludedChannelIds ?? []).includes(event.channelId);
      if (memoryExcluded) {
        if (this.ephemeralSeen.has(event.id)) {
          return {
            eventId: event.id,
            turnId: 'duplicate',
            text: '',
            silent: true,
            toolCalls: 0,
            requestIds: [],
            delivered: false,
          };
        }
        this.ephemeralSeen.add(event.id);
        const key = this.channelKey(event);
        const buffer = this.ephemeralChannels.get(key) ?? [];
        ephemeralRecent = [...buffer];
        this.appendEphemeral(key, event);
      }
    }

    if (!memoryExcluded) {
      const fresh = await this.database.storeEvent(event);
      if (!fresh) {
        return {
          eventId: event.id,
          turnId: 'duplicate',
          text: '',
          silent: true,
          toolCalls: 0,
          requestIds: [],
          delivered: false,
        };
      }
    }

    if (event.platform === 'twitch_chat' && !this.shouldProcessTwitchChat(event)) {
      this.logger.debug({ eventId: event.id }, 'Retained ambient Twitch chat without spending a cognitive turn');
      return {
        eventId: event.id,
        turnId: 'ambient-twitch-chat',
        text: '',
        silent: true,
        toolCalls: 0,
        requestIds: [],
        delivered: false,
      };
    }

    const priority = priorityForEvent(event);
    return this.queue.enqueue(event.id, priority, async () => {
      try {
        const scene = await this.assembler.assemble(event, ephemeralRecent);
        if (event.platform === 'discord_voice' && scene.platformState?.voiceConnected === false) {
          this.logger.info({ eventId: event.id }, 'Discarded a queued voice event after Cinder left the voice session');
          return {
            eventId: event.id, turnId: 'voice-session-ended', text: '', silent: true,
            toolCalls: 0, requestIds: [], delivered: false,
          };
        }
        const result = event.platform === 'discord_voice'
          ? await this.brain.takeVoiceTurn(scene)
          : event.platform === 'discord_text' || event.platform === 'twitch_chat' || event.platform === 'twitch_event'
            ? await this.brain.takeSocialTurn(scene)
            : await this.brain.takeTurn(scene);
        let delivered = false;

        if (!result.silent && result.text && deliverResponse) {
          const delivery = await this.deliver(event, result.text);
          if (!delivery.ok) {
            this.logger.error({ eventId: event.id, result: delivery }, 'Cinder response delivery failed');
          } else {
            delivered = true;
          }
        }

        if (!result.silent && result.text) {
          const response = this.cinderResponse(event, result.turnId, result.text);
          if (memoryExcluded) this.appendEphemeral(this.channelKey(event), response);
          else await this.database.storeEvent(response);
        }

        return { eventId: event.id, ...result, delivered };
      } catch (error) {
        const failure = error instanceof CinderTurnError
          ? error
          : new CinderTurnError(error instanceof Error ? error.message : String(error), error);

        await this.database.recordTurnFailure({
          id: failure.errorId,
          event,
          error: failure,
          ...(failure.requestId ? { requestId: failure.requestId } : {}),
          ...(failure.code ? { code: failure.code } : {}),
          ...(failure.status !== undefined ? { status: failure.status } : {}),
        }).catch((recordError) => {
          this.logger.error({ err: recordError, originalErrorId: failure.errorId }, 'Failed to record Cinder turn failure');
        });

        this.logger.error({
          err: error,
          eventId: event.id,
          errorId: failure.errorId,
          requestId: failure.requestId,
          code: failure.code,
          status: failure.status,
        }, 'Cinder failed to process event');

        if (deliverResponse && this.wasDirectlyEngaged(event)) {
          const shortReason = this.publicFailureReason(failure);
          await this.deliver(
            event,
            `I hit a real fault while thinking: ${shortReason} Error ${failure.errorId.slice(0, 8)} is in the dashboard.`,
          ).catch(() => undefined);
        }
        throw failure;
      }
    });
  }

  private async deliver(event: EventEnvelope, text: string): Promise<ToolExecutionResult> {
    if (event.platform === 'discord_text' || event.platform === 'discord_voice') {
      return this.discord.deliver(event, text);
    }
    if (event.platform === 'twitch_chat' || event.platform === 'twitch_event') {
      if (!this.twitch) return { ok: false, summary: 'Twitch is disabled.', errorCode: 'TWITCH_DISABLED' };
      return this.twitch.deliver(event, text);
    }
    return { ok: true, summary: 'The response was internal and required no platform delivery.' };
  }

  private cinderResponse(source: EventEnvelope, turnId: string, text: string): EventEnvelope {
    return {
      id: `cinder-response:${turnId}`,
      platform: source.platform,
      occurredAt: new Date().toISOString(),
      ...(source.serverId ? { serverId: source.serverId } : {}),
      ...(source.channelId ? { channelId: source.channelId } : {}),
      ...(source.channelName ? { channelName: source.channelName } : {}),
      ...(source.threadId ? { threadId: source.threadId } : {}),
      ...(source.voiceChannelId ? { voiceChannelId: source.voiceChannelId } : {}),
      actor: {
        platform: 'system',
        platformUserId: 'cinder',
        displayName: 'Cinder',
        roles: [],
        isBot: true,
      },
      text,
      mentions: [],
      attachments: [],
      metadata: {
        verified: true,
        cinderGenerated: true,
        responseToEventId: source.id,
        turnId,
      },
    };
  }

  private channelKey(event: EventEnvelope): string {
    return `${event.serverId ?? event.platform}:${event.channelId ?? event.voiceChannelId ?? 'default'}`;
  }

  private appendEphemeral(key: string, event: EventEnvelope): void {
    const buffer = this.ephemeralChannels.get(key) ?? [];
    buffer.push(event);
    if (buffer.length > this.config.SCENE_RECENT_EVENT_LIMIT) {
      const removed = buffer.splice(0, buffer.length - this.config.SCENE_RECENT_EVENT_LIMIT);
      for (const item of removed) this.ephemeralSeen.delete(item.id);
    }
    this.ephemeralChannels.set(key, buffer);
  }

  private wasDirectlyEngaged(event: EventEnvelope): boolean {
    return event.platform === 'discord_voice'
      || event.metadata.directMention === true
      || event.metadata.replyToCinder === true
      || event.metadata.dashboard === true
      || event.platform === 'windows';
  }

  private shouldProcessTwitchChat(event: EventEnvelope): boolean {
    if (event.metadata.deploymentVerification === true
      || event.metadata.directMention === true
      || event.metadata.replyToCinder === true
      || event.metadata.moderationCandidate === true) return true;

    // Synthetic and older callers may not supply engagement metadata. Keep the
    // fallback deliberately strict: Cinder's name must appear as its own word.
    return /(?:^|\W)@?cinder(?:_ai)?(?:\W|$)/i.test(event.text);
  }

  private publicFailureReason(error: CinderTurnError): string {
    if (error.status === 401) return 'OpenAI rejected the API credentials.';
    if (error.status === 429) return 'OpenAI rate-limited the request.';
    if (error.code === 'invalid_function_parameters') return 'OpenAI rejected one of my tool definitions.';
    if (error.code === 'model_not_found') return 'the configured OpenAI model is unavailable.';
    if (/timeout/i.test(error.message)) return 'the OpenAI request timed out.';
    return 'the cognitive request failed.';
  }
}
