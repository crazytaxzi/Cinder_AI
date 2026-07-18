import { randomUUID } from 'node:crypto';
import type { EventEnvelope, Scene } from '@cinder/shared';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { Database } from '../db/database.js';
import type { DiscordAdapter } from '../adapters/discord.js';
import type { TwitchAdapter } from '../adapters/twitch.js';
import type { CinderRuntime } from '../cinder/runtime.js';
import type { CinderBrain } from '../cinder/brain.js';
import type { SceneAssembler } from '../scene/assembler.js';

export interface LiveVerificationStep {
  name: string;
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export interface LiveVerificationReport {
  ok: boolean;
  startedAt: string;
  completedAt: string;
  steps: LiveVerificationStep[];
}

export class LiveVerifier {
  private running: Promise<LiveVerificationReport> | undefined;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly database: Database,
    private readonly discord: DiscordAdapter,
    private readonly runtime: CinderRuntime,
    private readonly brain: CinderBrain,
    private readonly assembler: SceneAssembler,
    private readonly twitch?: TwitchAdapter,
  ) {}

  run(): Promise<LiveVerificationReport> {
    if (this.running) return this.running;
    this.running = this.execute().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async execute(): Promise<LiveVerificationReport> {
    const startedAt = new Date().toISOString();
    const steps: LiveVerificationStep[] = [];
    const cleanupChannelIds: string[] = [];

    try {
      const selfTest = await this.brain.startupSelfTest();
      steps.push({
        name: 'openai_full_tool_round_trip',
        ok: selfTest.ok,
        summary: selfTest.summary,
        details: { requestIds: selfTest.requestIds, toolCount: selfTest.toolCount },
      });

      if (!this.discord.isReady()) throw new Error('Discord is not connected.');
      steps.push({ name: 'discord_connection', ok: true, summary: 'Discord gateway is connected.' });

      const suffix = randomUUID().slice(0, 6);
      const responseChannel = await this.discord.createChannel({
        serverId: this.config.DISCORD_GUILD_ID,
        name: `cinder-live-check-${suffix}`,
        kind: 'text',
        topic: 'Temporary Cinder deployment verification channel. It will be removed automatically.',
      });
      const responseChannelId = this.channelId(responseChannel);
      cleanupChannelIds.push(responseChannelId);

      const chatEvent = this.discordVerificationEvent({
        id: `verify-discord-chat:${randomUUID()}`,
        channelId: responseChannelId,
        text: 'Cinder, this is a deployment verification. Reply briefly and include the exact marker LIVE_CHAT_OK.',
      });
      await this.database.storeEvent(chatEvent);
      const chatScene = await this.assembler.assemble(chatEvent);
      const chatResult = await this.brain.takeVerificationTurn({
        scene: chatScene,
        instructions: [
          'This is a live normal-conversation verification for the one Cinder mind.',
          'Do not call a tool. Reply naturally and briefly to Senti.',
          'Include the exact marker LIVE_CHAT_OK somewhere in the reply.',
        ].join(' '),
        firstToolChoice: 'none',
        maxRounds: 1,
      });
      const chatDelivery = await this.discord.deliver(chatEvent, chatResult.text);
      const chatOk = chatDelivery.ok && /LIVE_CHAT_OK/i.test(chatResult.text);
      steps.push({
        name: 'discord_normal_chat',
        ok: chatOk,
        summary: chatOk
          ? 'Cinder completed a real OpenAI conversation turn and delivered it to Discord.'
          : 'Cinder did not complete the normal Discord conversation check.',
        details: { text: chatResult.text, delivery: chatDelivery, toolCalls: chatResult.toolCalls, requestIds: chatResult.requestIds },
      });
      if (!chatOk) throw new Error('Discord normal-chat live verification failed.');

      const adminChannelName = `cinder-admin-check-${suffix}`;
      const adminEvent = this.discordVerificationEvent({
        id: `verify-discord-admin:${randomUUID()}`,
        channelId: responseChannelId,
        text: `Create a temporary text channel named ${adminChannelName}. This is a harmless deployment verification requested by a moderator.`,
      });
      await this.database.storeEvent(adminEvent);
      const adminScene = await this.assembler.assemble(adminEvent);
      const adminResult = await this.brain.takeVerificationTurn({
        scene: adminScene,
        instructions: [
          'This is a live Cinder deployment verification using the complete real tool set.',
          `Call discord_create_channel and create a text channel named exactly ${adminChannelName}.`,
          'Do not request approval because the channel is temporary and harmless.',
          'After the tool returns, respond briefly with the result.',
        ].join(' '),
        firstToolChoice: { type: 'function', name: 'discord_create_channel' },
        maxRounds: 3,
      });
      const action = (await this.database.dashboardActions({
        limit: 50,
        serverId: this.config.DISCORD_GUILD_ID,
      })).find((item) => item.eventId === adminEvent.id && item.toolName === 'discord_create_channel');
      const createdId = action?.result.data?.channelId;
      const adminOk = Boolean(action?.result.ok && typeof createdId === 'string');
      if (typeof createdId === 'string') cleanupChannelIds.push(createdId);
      steps.push({
        name: 'discord_moderator_admin_action',
        ok: adminOk,
        summary: adminOk
          ? 'Cinder selected and executed a harmless moderator-requested Discord administration tool.'
          : 'The moderator-requested Discord tool was not completed.',
        details: {
          response: adminResult.text,
          toolCalls: adminResult.toolCalls,
          actionResult: action?.result,
        },
      });
      if (!adminOk) throw new Error('Discord administration live verification failed.');

      if (this.config.TWITCH_ENABLED) {
        if (!this.twitch?.isReady()) throw new Error('Twitch EventSub is not connected.');
        const twitchEvent = this.twitchVerificationEvent();
        await this.database.storeEvent(twitchEvent);
        const twitchScene = await this.assembler.assemble(twitchEvent);
        const twitchResult = await this.brain.takeVerificationTurn({
          scene: twitchScene,
          instructions: [
            'This is a live Twitch-chat pipeline verification for the one Cinder mind.',
            'Do not call a tool. Reply briefly to CinderVerifier by name.',
            'Include the exact marker LIVE_TWITCH_OK somewhere in the reply.',
          ].join(' '),
          firstToolChoice: 'none',
          maxRounds: 1,
        });
        const twitchDelivery = await this.twitch.deliver(twitchEvent, twitchResult.text);
        const twitchOk = twitchDelivery.ok && /LIVE_TWITCH_OK/i.test(twitchResult.text);
        steps.push({
          name: 'twitch_chat_pipeline',
          ok: twitchOk,
          summary: twitchOk
            ? 'Cinder processed a Twitch chat scene and delivered the reply through the live Twitch API.'
            : 'Cinder did not complete the Twitch chat verification.',
          details: { text: twitchResult.text, delivery: twitchDelivery, toolCalls: twitchResult.toolCalls, requestIds: twitchResult.requestIds },
        });
        if (!twitchOk) throw new Error('Twitch chat live verification failed.');
      } else {
        steps.push({ name: 'twitch_chat_pipeline', ok: true, summary: 'Twitch is disabled; the Twitch live check was skipped.' });
      }
    } catch (error) {
      this.logger.error({ err: error, steps }, 'Cinder live verification failed');
      steps.push({
        name: 'verification_failure',
        ok: false,
        summary: error instanceof Error ? error.message : String(error),
      });
    } finally {
      for (const channelId of [...cleanupChannelIds].reverse()) {
        const result = await this.discord.deleteChannel({
          serverId: this.config.DISCORD_GUILD_ID,
          channelReference: channelId,
          reason: 'Cinder deployment verification cleanup',
        }).catch((error) => ({ ok: false, summary: String(error) }));
        if (!result.ok) {
          this.logger.warn({ channelId, result }, 'Could not remove a temporary Cinder verification channel');
        }
      }
    }

    return {
      ok: steps.every((step) => step.ok),
      startedAt,
      completedAt: new Date().toISOString(),
      steps,
    };
  }

  private channelId(result: { ok: boolean; summary: string; data?: Record<string, unknown> }): string {
    if (!result.ok || typeof result.data?.channelId !== 'string') {
      throw new Error(`Could not create the temporary verification channel: ${result.summary}`);
    }
    return result.data.channelId;
  }

  private discordVerificationEvent(input: { id: string; channelId: string; text: string }): EventEnvelope {
    return {
      id: input.id,
      platform: 'discord_text',
      occurredAt: new Date().toISOString(),
      serverId: this.config.DISCORD_GUILD_ID,
      channelId: input.channelId,
      channelName: 'Cinder deployment verification',
      actor: {
        platform: 'discord',
        platformUserId: this.config.CINDER_OWNER_DISCORD_ID ?? 'deployment-owner',
        displayName: 'Senti',
        roles: [this.config.DEFAULT_MODERATOR_ROLE_NAME],
        isBot: false,
        isGuildOwner: true,
      },
      text: input.text,
      mentions: [],
      attachments: [],
      metadata: { verified: true, directMention: true, deploymentVerification: true },
    };
  }

  private twitchVerificationEvent(): EventEnvelope {
    const messageId = `cinder-twitch-check:${randomUUID()}`;
    return {
      id: messageId,
      platform: 'twitch_chat',
      occurredAt: new Date().toISOString(),
      ...(this.config.TWITCH_BROADCASTER_ID ? { channelId: this.config.TWITCH_BROADCASTER_ID } : {}),
      channelName: 'Sentionce Twitch chat',
      actor: {
        platform: 'twitch',
        platformUserId: 'cinder-deployment-verifier',
        displayName: 'CinderVerifier',
        username: 'cinderverifier',
        roles: [],
        isBot: false,
      },
      text: 'Cinder, reply briefly and include the exact marker LIVE_TWITCH_OK. This is deployment verification.',
      mentions: [],
      attachments: [],
      metadata: {
        verified: true,
        directMention: true,
        deploymentVerification: true,
        suppressReply: true,
        chatBatch: [{ messageId, displayName: 'CinderVerifier' }],
      },
    };
  }
}
