import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type AnyThreadChannel,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type Role,
  type TextBasedChannel,
  type VoiceBasedChannel,
} from 'discord.js';
import type {
  EventEnvelope,
  MessageReference,
  ToolExecutionResult,
} from '@cinder/shared';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { SceneStateProvider } from '../scene/assembler.js';
import type { DiscordToolPort } from '../tools/ports.js';
import { VoiceManager } from '../voice/manager.js';

export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/^#/, '')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cleanReference(value: string): string {
  return value.trim().replace(/^discord:(?:channel|message|role|user):/, '');
}

function snowflakeFrom(value: string): string | undefined {
  const cleaned = cleanReference(value);
  const mention = cleaned.match(/^<[@#]&?!?(\d+)>$/)?.[1]
    ?? cleaned.match(/^<@!?(\d+)>$/)?.[1]
    ?? cleaned.match(/^<#(\d+)>$/)?.[1]
    ?? cleaned.match(/^<@&(\d+)>$/)?.[1];
  if (mention) return mention;
  return /^\d{15,22}$/.test(cleaned) ? cleaned : undefined;
}

export class DiscordAdapter implements DiscordToolPort, SceneStateProvider {
  readonly client: Client;
  readonly voice: VoiceManager;
  private ready = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly emitEvent: (event: EventEnvelope) => Promise<void>,
    audioUsageRecorder?: { recordAudioUsage(input: {
      model: string; durationSeconds: number; estimatedCostUsd: number; platform: string;
    }): Promise<void> },
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    });
    this.voice = new VoiceManager(this.client, config, logger, emitEvent, audioUsageRecorder);
    this.bindEvents();
  }

  async start(): Promise<void> {
    await this.client.login(this.config.DISCORD_TOKEN);
    if (!this.client.isReady()) {
      await new Promise<void>((resolve) => this.client.once(Events.ClientReady, () => resolve()));
    }
    await this.registerMaintenanceCommand();
  }

  async stop(): Promise<void> {
    for (const guild of this.client.guilds.cache.values()) {
      await this.voice.leave(guild.id);
    }
    await this.voice.stop();
    this.client.destroy();
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready && this.client.isReady();
  }

  async deliver(event: EventEnvelope, text: string): Promise<ToolExecutionResult> {
    if (!text.trim()) return { ok: true, summary: 'No response was needed.' };

    if (event.platform === 'discord_voice') {
      if (!event.serverId) return { ok: false, summary: 'Voice response has no server.', errorCode: 'NO_SERVER' };
      return this.voice.speak(event.serverId, text);
    }

    if (event.platform !== 'discord_text' || !event.channelId) {
      return { ok: false, summary: 'The event is not a Discord text event.', errorCode: 'WRONG_PLATFORM' };
    }

    const channel = this.client.channels.cache.get(event.channelId)
      ?? await this.client.channels.fetch(event.channelId);
    if (!channel?.isTextBased() || !('send' in channel)) {
      return { ok: false, summary: 'The Discord channel cannot receive text.', errorCode: 'CHANNEL_NOT_TEXT' };
    }

    const currentMessageId = typeof event.metadata.messageId === 'string'
      ? event.metadata.messageId
      : undefined;

    try {
      if (currentMessageId && 'messages' in channel) {
        const current = channel.messages.cache.get(currentMessageId)
          ?? await channel.messages.fetch(currentMessageId).catch(() => undefined);
        if (current) {
          await current.reply({ content: text, allowedMentions: { repliedUser: false, parse: [] } });
          return { ok: true, summary: 'Replied in the current Discord channel.' };
        }
      }
      await channel.send({ content: text, allowedMentions: { parse: [] } });
      return { ok: true, summary: 'Sent a Discord message.' };
    } catch (error) {
      return this.failure('Could not send the Discord response.', error);
    }
  }

  async getServerSnapshot(event: EventEnvelope): Promise<Record<string, unknown> | undefined> {
    if (!event.serverId) return undefined;
    const guild = this.client.guilds.cache.get(event.serverId)
      ?? await this.client.guilds.fetch(event.serverId);

    const channels = guild.channels.cache
      .filter((channel): channel is GuildBasedChannel => Boolean(channel))
      .map((channel) => ({
        ref: `discord:channel:${channel.id}`,
        name: channel.name,
        type: ChannelType[channel.type] ?? String(channel.type),
        parentRef: channel.parentId ? `discord:channel:${channel.parentId}` : null,
        position: 'rawPosition' in channel ? channel.rawPosition : null,
      }))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    const roles = guild.roles.cache
      .filter((role) => role.id !== guild.id)
      .map((role) => ({
        ref: `discord:role:${role.id}`,
        name: role.name,
        position: role.position,
      }))
      .sort((a, b) => b.position - a.position);

    const actorMember = guild.members.cache.get(event.actor.platformUserId)
      ?? await guild.members.fetch(event.actor.platformUserId).catch(() => undefined);
    const mentionedUsers = event.mentions
      .filter((mention) => mention.kind === 'user')
      .map((mention) => ({ ref: `discord:user:${mention.id}`, displayName: mention.displayName }));

    const compactIdentity = {
      verified: true,
      guild: { id: guild.id, name: guild.name, ownerId: guild.ownerId },
      cinder: {
        userId: this.client.user?.id,
        displayName: guild.members.me?.displayName ?? this.client.user?.displayName,
        permissions: guild.members.me?.permissions.toArray() ?? [],
        highestRolePosition: guild.members.me?.roles.highest.position ?? 0,
      },
      currentActor: actorMember
        ? {
            ref: `discord:user:${actorMember.id}`,
            displayName: actorMember.displayName,
            roles: actorMember.roles.cache.filter((role) => role.id !== guild.id).map((role) => ({
              ref: `discord:role:${role.id}`,
              name: role.name,
              position: role.position,
            })),
            highestRolePosition: actorMember.roles.highest.position,
          }
        : undefined,
      currentChannelRef: event.channelId ? `discord:channel:${event.channelId}` : undefined,
    };

    if (event.platform === 'discord_voice') return compactIdentity;

    return {
      ...compactIdentity,
      currentMessageRef: typeof event.metadata.messageId === 'string'
        ? `discord:message:${event.metadata.messageId}`
        : undefined,
      replyTarget: event.replyTo,
      mentionedUsers,
      channels,
      roles,
    };
  }

  async getPlatformState(event: EventEnvelope): Promise<Record<string, unknown> | undefined> {
    if (!event.serverId) return undefined;
    return {
      platform: 'discord',
      connected: this.isReady(),
      voiceParticipants: this.voice.activeParticipants(event.serverId),
    };
  }

  getActiveVoiceParticipants(serverId?: string) {
    return this.voice.activeParticipants(serverId);
  }

  async sendMessage(input: {
    serverId: string;
    channelReference: string;
    text: string;
    replyToMessageReference?: string;
  }): Promise<ToolExecutionResult> {
    const channel = await this.resolveTextChannel(input.serverId, input.channelReference);
    if (!channel || !('send' in channel)) {
      return { ok: false, summary: 'I could not resolve a writable text channel.', errorCode: 'CHANNEL_NOT_FOUND' };
    }
    try {
      if (input.replyToMessageReference && 'messages' in channel) {
        const messageId = this.messageIdFrom(input.replyToMessageReference);
        if (!messageId) return { ok: false, summary: 'I could not resolve the reply target.', errorCode: 'MESSAGE_NOT_FOUND' };
        const message = await channel.messages.fetch(messageId);
        await message.reply({ content: input.text, allowedMentions: { repliedUser: false, parse: [] } });
      } else {
        await channel.send({ content: input.text, allowedMentions: { parse: [] } });
      }
      return { ok: true, summary: `Message sent to #${'name' in channel ? channel.name : channel.id}.`, data: { channelId: channel.id } };
    } catch (error) {
      return this.failure('Discord rejected the message.', error);
    }
  }

  async addReaction(input: {
    serverId: string;
    channelReference: string;
    messageReference: string;
    emoji: string;
  }): Promise<ToolExecutionResult> {
    const channel = await this.resolveTextChannel(input.serverId, input.channelReference);
    const messageId = this.messageIdFrom(input.messageReference);
    if (!channel || !('messages' in channel) || !messageId) {
      return { ok: false, summary: 'I could not resolve that Discord message.', errorCode: 'MESSAGE_NOT_FOUND' };
    }
    try {
      const message = await channel.messages.fetch(messageId);
      await message.react(input.emoji);
      return { ok: true, summary: 'Reaction added.' };
    } catch (error) {
      return this.failure('Discord rejected the reaction.', error);
    }
  }

  async createChannel(input: {
    serverId: string;
    name: string;
    kind: 'text' | 'voice' | 'category' | 'forum';
    categoryReference?: string;
    topic?: string;
  }): Promise<ToolExecutionResult> {
    const guild = await this.guild(input.serverId);
    const parent = input.categoryReference
      ? await this.resolveChannel(guild, input.categoryReference, ChannelType.GuildCategory)
      : undefined;
    if (input.categoryReference && !parent) {
      return { ok: false, summary: 'I could not resolve the parent category.', errorCode: 'CATEGORY_NOT_FOUND' };
    }

    const channelTypes = {
      text: ChannelType.GuildText,
      voice: ChannelType.GuildVoice,
      category: ChannelType.GuildCategory,
      forum: ChannelType.GuildForum,
    } as const;
    const type = channelTypes[input.kind];

    try {
      const created = await guild.channels.create({
        name: input.name,
        type,
        ...(parent ? { parent: parent.id } : {}),
        ...(input.topic && (type === ChannelType.GuildText || type === ChannelType.GuildForum)
          ? { topic: input.topic }
          : {}),
        reason: `Created naturally by Cinder for ${guild.name}`,
      });
      return {
        ok: true,
        summary: `Created ${input.kind} channel ${created.name}.`,
        data: { channelId: created.id, channelRef: `discord:channel:${created.id}`, name: created.name },
      };
    } catch (error) {
      return this.failure('Discord refused to create the channel.', error);
    }
  }

  async renameChannel(input: {
    serverId: string;
    channelReference: string;
    newName: string;
  }): Promise<ToolExecutionResult> {
    const guild = await this.guild(input.serverId);
    const channel = await this.resolveChannel(guild, input.channelReference);
    if (!channel) return { ok: false, summary: 'I could not resolve that channel.', errorCode: 'CHANNEL_NOT_FOUND' };
    const oldName = channel.name;
    try {
      await channel.setName(input.newName, `Renamed naturally by Cinder`);
      return { ok: true, summary: `Renamed ${oldName} to ${input.newName}.`, data: { channelId: channel.id, oldName, newName: input.newName } };
    } catch (error) {
      return this.failure('Discord refused to rename that channel.', error);
    }
  }

  async moveChannel(input: {
    serverId: string;
    channelReference: string;
    categoryReference?: string;
    position?: number;
  }): Promise<ToolExecutionResult> {
    const guild = await this.guild(input.serverId);
    const channel = await this.resolveChannel(guild, input.channelReference);
    if (!channel || channel.type === ChannelType.GuildCategory) {
      return { ok: false, summary: 'I could not resolve a movable channel.', errorCode: 'CHANNEL_NOT_FOUND' };
    }
    try {
      if (input.categoryReference !== undefined && 'setParent' in channel) {
        if (normalizeName(input.categoryReference) === 'none') {
          await channel.setParent(null, { lockPermissions: false, reason: 'Moved by Cinder' });
        } else {
          const category = await this.resolveChannel(guild, input.categoryReference, ChannelType.GuildCategory);
          if (!category) return { ok: false, summary: 'I could not resolve that category.', errorCode: 'CATEGORY_NOT_FOUND' };
          await channel.setParent(category.id, { lockPermissions: false, reason: 'Moved by Cinder' });
        }
      }
      if (input.position !== undefined && 'setPosition' in channel) {
        await channel.setPosition(input.position, { reason: 'Position changed by Cinder' });
      }
      return { ok: true, summary: `Moved ${channel.name}.`, data: { channelId: channel.id } };
    } catch (error) {
      return this.failure('Discord refused to move that channel.', error);
    }
  }

  async deleteChannel(input: {
    serverId: string;
    channelReference: string;
    reason?: string;
  }): Promise<ToolExecutionResult> {
    const guild = await this.guild(input.serverId);
    const channel = await this.resolveChannel(guild, input.channelReference);
    if (!channel) return { ok: false, summary: 'I could not resolve that channel.', errorCode: 'CHANNEL_NOT_FOUND' };
    const name = channel.name;
    try {
      await channel.delete(input.reason ?? 'Deleted by Cinder');
      return { ok: true, summary: `Deleted ${name}.`, data: { channelId: channel.id, name } };
    } catch (error) {
      return this.failure('Discord refused to delete that channel.', error);
    }
  }

  async setChannelReadOnly(input: {
    serverId: string;
    channelReference: string;
    readOnly: boolean;
    roleReference?: string;
  }): Promise<ToolExecutionResult> {
    const guild = await this.guild(input.serverId);
    const channel = await this.resolveChannel(guild, input.channelReference);
    if (!channel || !('permissionOverwrites' in channel)) {
      return { ok: false, summary: 'I could not resolve a channel with permission overwrites.', errorCode: 'CHANNEL_NOT_FOUND' };
    }
    const role = input.roleReference
      ? await this.resolveRole(guild, input.roleReference)
      : guild.roles.everyone;
    if (!role) return { ok: false, summary: 'I could not resolve that role.', errorCode: 'ROLE_NOT_FOUND' };

    try {
      await channel.permissionOverwrites.edit(
        role,
        { SendMessages: input.readOnly ? false : null },
        { reason: 'Channel write access changed by Cinder' },
      );
      return {
        ok: true,
        summary: `${channel.name} is now ${input.readOnly ? 'read-only' : 'writable'} for ${role.name}.`,
      };
    } catch (error) {
      return this.failure('Discord refused the channel permission change.', error);
    }
  }

  async deleteMessage(input: {
    serverId: string;
    channelReference: string;
    messageReference: string;
    reason?: string;
  }): Promise<ToolExecutionResult> {
    const channel = await this.resolveTextChannel(input.serverId, input.channelReference);
    const messageId = this.messageIdFrom(input.messageReference);
    if (!channel || !('messages' in channel) || !messageId) {
      return { ok: false, summary: 'I could not resolve that message.', errorCode: 'MESSAGE_NOT_FOUND' };
    }
    try {
      const message = await channel.messages.fetch(messageId);
      const authorName = message.member?.displayName ?? message.author.displayName ?? message.author.username;
      await message.delete();
      return { ok: true, summary: `Deleted the message from ${authorName}.`, data: { messageId, reason: input.reason ?? null } };
    } catch (error) {
      return this.failure('Discord refused to delete that message.', error);
    }
  }

  async pinMessage(input: {
    serverId: string;
    channelReference: string;
    messageReference: string;
    pin: boolean;
  }): Promise<ToolExecutionResult> {
    const channel = await this.resolveTextChannel(input.serverId, input.channelReference);
    const messageId = this.messageIdFrom(input.messageReference);
    if (!channel || !('messages' in channel) || !messageId) {
      return { ok: false, summary: 'I could not resolve that message.', errorCode: 'MESSAGE_NOT_FOUND' };
    }
    try {
      const message = await channel.messages.fetch(messageId);
      if (input.pin) await message.pin('Pinned by Cinder');
      else await message.unpin('Unpinned by Cinder');
      return { ok: true, summary: input.pin ? 'Message pinned.' : 'Message unpinned.' };
    } catch (error) {
      return this.failure(`Discord refused to ${input.pin ? 'pin' : 'unpin'} that message.`, error);
    }
  }

  async timeoutMember(input: {
    serverId: string;
    userReference: string;
    minutes: number;
    reason?: string;
  }): Promise<ToolExecutionResult> {
    const guild = await this.guild(input.serverId);
    const member = await this.resolveMember(guild, input.userReference);
    if (!member) return { ok: false, summary: 'I could not resolve that member.', errorCode: 'MEMBER_NOT_FOUND' };
    try {
      await member.timeout(input.minutes === 0 ? null : input.minutes * 60_000, input.reason ?? 'Moderated by Cinder');
      return {
        ok: true,
        summary: input.minutes === 0
          ? `Cleared ${member.displayName}'s timeout.`
          : `Timed out ${member.displayName} for ${input.minutes} minute${input.minutes === 1 ? '' : 's'}.`,
      };
    } catch (error) {
      return this.failure('Discord refused the timeout.', error);
    }
  }

  async banMember(input: {
    serverId: string;
    userReference: string;
    reason?: string;
    deleteMessageSeconds?: number;
  }): Promise<ToolExecutionResult> {
    const guild = await this.guild(input.serverId);
    const member = await this.resolveMember(guild, input.userReference);
    if (!member) return { ok: false, summary: 'I could not resolve that member.', errorCode: 'MEMBER_NOT_FOUND' };
    try {
      await member.ban({
        reason: input.reason ?? 'Banned by Cinder',
        deleteMessageSeconds: input.deleteMessageSeconds ?? 0,
      });
      return { ok: true, summary: `Banned ${member.displayName}.` };
    } catch (error) {
      return this.failure('Discord refused the ban.', error);
    }
  }

  async createRole(input: {
    serverId: string;
    name: string;
    color?: string;
    mentionable?: boolean;
    hoist?: boolean;
  }): Promise<ToolExecutionResult> {
    const guild = await this.guild(input.serverId);
    const color = input.color ? Number.parseInt(input.color.replace(/^#/, ''), 16) : undefined;
    if (input.color && !Number.isFinite(color)) {
      return { ok: false, summary: 'That role color is not valid hexadecimal.', errorCode: 'INVALID_COLOR' };
    }
    try {
      const role = await guild.roles.create({
        name: input.name,
        ...(color !== undefined ? { color } : {}),
        mentionable: input.mentionable ?? false,
        hoist: input.hoist ?? false,
        reason: 'Created by Cinder',
      });
      return { ok: true, summary: `Created role ${role.name}.`, data: { roleId: role.id, roleRef: `discord:role:${role.id}` } };
    } catch (error) {
      return this.failure('Discord refused to create that role.', error);
    }
  }

  async assignRole(input: {
    serverId: string;
    userReference: string;
    roleReference: string;
    assign: boolean;
  }): Promise<ToolExecutionResult> {
    const guild = await this.guild(input.serverId);
    const [member, role] = await Promise.all([
      this.resolveMember(guild, input.userReference),
      this.resolveRole(guild, input.roleReference),
    ]);
    if (!member) return { ok: false, summary: 'I could not resolve that member.', errorCode: 'MEMBER_NOT_FOUND' };
    if (!role) return { ok: false, summary: 'I could not resolve that role.', errorCode: 'ROLE_NOT_FOUND' };
    try {
      if (input.assign) await member.roles.add(role, 'Role assigned by Cinder');
      else await member.roles.remove(role, 'Role removed by Cinder');
      return { ok: true, summary: `${input.assign ? 'Assigned' : 'Removed'} ${role.name} ${input.assign ? 'to' : 'from'} ${member.displayName}.` };
    } catch (error) {
      return this.failure('Discord refused the role change.', error);
    }
  }

  async joinVoice(input: {
    event: EventEnvelope;
    channelReference?: string;
  }): Promise<ToolExecutionResult> {
    if (!input.event.serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
    const guild = await this.guild(input.event.serverId);
    let channel: VoiceBasedChannel | undefined;

    if (input.channelReference) {
      const resolved = await this.resolveChannel(guild, input.channelReference);
      if (resolved?.isVoiceBased()) channel = resolved;
    } else {
      const member = await guild.members.fetch(input.event.actor.platformUserId).catch(() => undefined);
      channel = member?.voice.channel ?? undefined;
    }

    if (!channel) return { ok: false, summary: 'I could not find the voice channel you meant.', errorCode: 'VOICE_CHANNEL_NOT_FOUND' };
    return this.voice.join(guild, channel);
  }

  async leaveVoice(input: { serverId: string }): Promise<ToolExecutionResult> {
    return this.voice.leave(input.serverId);
  }

  async fetchMessages(input: {
    serverId: string;
    channelReference: string;
    limit: number;
    beforeMessageReference?: string;
  }): Promise<EventEnvelope[]> {
    const channel = await this.resolveTextChannel(input.serverId, input.channelReference);
    if (!channel || !('messages' in channel)) throw new Error('I could not resolve a readable text channel.');
    const before = input.beforeMessageReference
      ? this.messageIdFrom(input.beforeMessageReference)
      : undefined;
    if (input.beforeMessageReference && !before) throw new Error('I could not resolve the before-message reference.');
    const messages = await channel.messages.fetch({ limit: input.limit, ...(before ? { before } : {}) });
    const events = await Promise.all(
      [...messages.values()]
        .filter((message): message is Message<true> => message.inGuild() && !message.author.bot)
        .map((message) => this.messageToEvent(message)),
    );
    return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  async findMessagesByUser(input: {
    serverId: string;
    channelReference: string;
    userReference: string;
    scanLimit: number;
    resultLimit: number;
    query?: string;
  }): Promise<{ events: EventEnvelope[]; scanned: number; channelId: string; channelName: string; userId: string; userName: string }> {
    const guild = await this.guild(input.serverId);
    const channel = await this.resolveTextChannel(input.serverId, input.channelReference);
    if (!channel || !('messages' in channel)) throw new Error('I could not resolve a readable text channel.');
    const member = await this.resolveMember(guild, input.userReference);
    if (!member) throw new Error('I could not uniquely resolve that Discord user.');

    const events: EventEnvelope[] = [];
    const query = input.query?.toLocaleLowerCase();
    let scanned = 0;
    let before: string | undefined;
    while (scanned < input.scanLimit && events.length < input.resultLimit) {
      const pageSize = Math.min(100, input.scanLimit - scanned);
      const page = await channel.messages.fetch({ limit: pageSize, ...(before ? { before } : {}) });
      if (page.size === 0) break;
      scanned += page.size;
      const ordered = [...page.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      before = ordered.at(-1)?.id;
      const matches = ordered.filter((message): message is Message<true> =>
        message.inGuild()
        && !message.author.bot
        && message.author.id === member.id
        && (!query || message.content.toLocaleLowerCase().includes(query)),
      );
      for (const message of matches) {
        events.push(await this.messageToEvent(message));
        if (events.length >= input.resultLimit) break;
      }
      if (page.size < pageSize) break;
    }
    return {
      events,
      scanned,
      channelId: channel.id,
      channelName: ('name' in channel ? channel.name : undefined) ?? channel.id,
      userId: member.id,
      userName: member.displayName,
    };
  }

  async resolveChannelId(serverId: string, reference: string): Promise<string | undefined> {
    const guild = await this.guild(serverId);
    return (await this.resolveChannel(guild, reference))?.id;
  }

  async resolveRoleName(serverId: string, reference: string): Promise<string | undefined> {
    const guild = await this.guild(serverId);
    return (await this.resolveRole(guild, reference))?.name;
  }

  async resolveUserIdentity(serverId: string, reference: string): Promise<{ id: string; displayName: string; username: string } | undefined> {
    const guild = await this.guild(serverId);
    const member = await this.resolveMember(guild, reference);
    return member ? { id: member.id, displayName: member.displayName, username: member.user.username } : undefined;
  }

  private bindEvents(): void {
    this.client.once(Events.ClientReady, (client) => {
      this.ready = true;
      this.logger.info({ user: client.user.tag, guilds: client.guilds.cache.size }, 'Cinder connected to Discord');
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message).catch((error) => {
        this.logger.error({ err: error, messageId: message.id }, 'Discord message ingestion failed');
      });
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'cinder') return;
      if (interaction.options.getSubcommand() === 'status') {
        void interaction.reply({
          content: this.isReady() ? 'Cinder is awake. Try not to look so relieved.' : 'Cinder is connected badly enough to answer this, which is suspicious.',
          ephemeral: true,
        });
      }
    });

    this.client.on(Events.Error, (error) => this.logger.error({ err: error }, 'Discord client error'));
    this.client.on(Events.Warn, (message) => this.logger.warn({ message }, 'Discord client warning'));
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot) return;
    const event = await this.messageToEvent(message);
    await this.emitEvent(event);
  }

  private async messageToEvent(message: Message<true>): Promise<EventEnvelope> {
    const member = message.member ?? await message.guild.members.fetch(message.author.id);
    let replyTo: MessageReference | undefined;
    if (message.reference?.messageId) {
      const referenced = await message.fetchReference().catch(() => undefined);
      replyTo = {
        platform: 'discord',
        serverId: message.guild.id,
        channelId: message.reference.channelId ?? message.channelId,
        messageId: message.reference.messageId,
        ...(referenced
          ? {
              authorId: referenced.author.id,
              authorName: referenced.member?.displayName ?? referenced.author.displayName ?? referenced.author.username,
              excerpt: referenced.content.slice(0, 500),
            }
          : {}),
      };
    }

    return {
      id: `discord-message:${message.id}`,
      platform: 'discord_text',
      occurredAt: message.createdAt.toISOString(),
      serverId: message.guild.id,
      channelId: message.channelId,
      channelName: 'name' in message.channel ? message.channel.name : message.channelId,
      ...(message.channel.isThread() ? { threadId: message.channel.id } : {}),
      actor: {
        platform: 'discord',
        platformUserId: message.author.id,
        displayName: member.displayName,
        username: message.author.username,
        roles: member.roles.cache.filter((role) => role.id !== message.guild.id).map((role) => role.name),
        isBot: false,
        isGuildOwner: message.author.id === message.guild.ownerId,
      },
      text: message.content || (message.attachments.size > 0 ? '[Attachment without message text]' : ''),
      ...(replyTo ? { replyTo } : {}),
      mentions: [
        ...message.mentions.users.map((user) => ({
          id: user.id,
          displayName: message.guild.members.cache.get(user.id)?.displayName ?? user.displayName ?? user.username,
          kind: 'user' as const,
        })),
        ...message.mentions.roles.map((role) => ({ id: role.id, displayName: role.name, kind: 'role' as const })),
        ...message.mentions.channels.map((channel) => ({
          id: channel.id,
          displayName: ('name' in channel ? channel.name : undefined) ?? channel.id,
          kind: 'channel' as const,
        })),
      ],
      attachments: message.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        url: attachment.url,
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
        sizeBytes: attachment.size,
      })),
      metadata: {
        verified: true,
        messageId: message.id,
        messageRef: `discord:message:${message.id}`,
        cinderUserId: this.client.user?.id,
        directMention: (this.client.user ? message.mentions.has(this.client.user) : false)
          || /(?:^|\W)cinder(?:_ai)?(?:\W|$)/i.test(message.content),
        replyToCinder: replyTo?.authorId === this.client.user?.id,
        authorUserRef: `discord:user:${message.author.id}`,
        channelRef: `discord:channel:${message.channelId}`,
      },
    };
  }

  private async registerMaintenanceCommand(): Promise<void> {
    const command = new SlashCommandBuilder()
      .setName('cinder')
      .setDescription('Cinder maintenance tools')
      .addSubcommand((subcommand) => subcommand.setName('status').setDescription('Check whether Cinder is connected'));

    const rest = new REST({ version: '10' }).setToken(this.config.DISCORD_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(this.config.DISCORD_APPLICATION_ID, this.config.DISCORD_GUILD_ID),
      { body: [command.toJSON()] },
    );
  }

  private async guild(serverId: string): Promise<Guild> {
    return this.client.guilds.fetch(serverId);
  }

  private async resolveChannel(
    guild: Guild,
    reference: string,
    requiredType?: ChannelType,
  ): Promise<GuildBasedChannel | undefined> {
    await guild.channels.fetch();
    const id = snowflakeFrom(reference);
    const byId = id ? guild.channels.cache.get(id) ?? undefined : undefined;
    if (byId && (requiredType === undefined || byId.type === requiredType)) return byId;

    const normalized = normalizeName(reference);
    const matches = guild.channels.cache.filter((channel) => {
      if (!channel) return false;
      if (requiredType !== undefined && channel.type !== requiredType) return false;
      return normalizeName(channel.name) === normalized;
    });
    if (matches.size === 1) return matches.first() ?? undefined;

    const partial = guild.channels.cache.filter((channel) => {
      if (!channel) return false;
      if (requiredType !== undefined && channel.type !== requiredType) return false;
      return normalizeName(channel.name).includes(normalized);
    });
    return partial.size === 1 ? partial.first() ?? undefined : undefined;
  }

  private async resolveTextChannel(serverId: string, reference: string): Promise<TextBasedChannel | undefined> {
    const guild = await this.guild(serverId);
    const channel = await this.resolveChannel(guild, reference);
    return channel?.isTextBased() ? channel : undefined;
  }

  private async resolveRole(guild: Guild, reference: string): Promise<Role | undefined> {
    await guild.roles.fetch();
    const id = snowflakeFrom(reference);
    if (id) return guild.roles.cache.get(id);
    const normalized = normalizeName(reference);
    const exact = guild.roles.cache.filter((role) => normalizeName(role.name) === normalized);
    if (exact.size === 1) return exact.first();
    const partial = guild.roles.cache.filter((role) => normalizeName(role.name).includes(normalized));
    return partial.size === 1 ? partial.first() : undefined;
  }

  private async resolveMember(guild: Guild, reference: string): Promise<GuildMember | undefined> {
    const id = snowflakeFrom(reference);
    if (id) return guild.members.fetch(id).catch(() => undefined);
    const normalized = reference.trim().toLocaleLowerCase();
    const fetched = await guild.members.search({ query: reference, limit: 25 }).catch(() => undefined);
    if (!fetched) return undefined;
    const exact = fetched.filter((member) =>
      member.displayName.toLocaleLowerCase() === normalized
      || member.user.username.toLocaleLowerCase() === normalized,
    );
    if (exact.size === 1) return exact.first();
    return fetched.size === 1 ? fetched.first() : undefined;
  }

  private messageIdFrom(reference: string): string | undefined {
    return snowflakeFrom(reference) ?? cleanReference(reference).match(/(\d{15,22})/)?.[1];
  }

  private failure(summary: string, error: unknown): ToolExecutionResult {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn({ err: error, summary }, 'Discord tool failed');
    return { ok: false, summary: `${summary} ${message}`, errorCode: 'DISCORD_API_ERROR', retryable: true };
  }
}
