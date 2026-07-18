import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AudienceScope,
  GuildConfiguration,
  Scene,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@cinder/shared';
import type { Config } from '../config/env.js';
import { voiceControlToolForScene } from '../voice/intents.js';
import type { Logger } from '../config/logger.js';
import type { Database } from '../db/database.js';
import type { BridgeToolPort, DiscordToolPort, TwitchToolPort } from './ports.js';

interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
}

type Handler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolExecutionResult>;

type JsonSchema = Record<string, unknown>;

function nullableSchema(schema: JsonSchema): JsonSchema {
  const type = schema.type;
  if (typeof type === 'string') {
    const next: JsonSchema = { ...schema, type: [type, 'null'] };
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) {
      next.enum = [...schema.enum, null];
    }
    return next;
  }
  if (Array.isArray(type)) {
    const next: JsonSchema = { ...schema, type: type.includes('null') ? type : [...type, 'null'] };
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) {
      next.enum = [...schema.enum, null];
    }
    return next;
  }
  return { anyOf: [schema, { type: 'null' }] };
}

const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema => {
  const originallyRequired = new Set(required);
  const strictProperties = Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => [
      name,
      originallyRequired.has(name) ? schema : nullableSchema(schema),
    ]),
  );

  return {
    type: 'object',
    properties: strictProperties,
    required: Object.keys(strictProperties),
    additionalProperties: false,
  };
};

function validateStrictSchema(schema: JsonSchema, path = 'parameters'): string[] {
  const errors: string[] = [];
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) {
      errors.push(`${path}.additionalProperties must be false`);
    }
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
    for (const [name, child] of Object.entries(properties)) {
      if (!required.has(name)) errors.push(`${path}.${name} is not required`);
      errors.push(...validateStrictSchema(child, `${path}.${name}`));
    }
  }
  if (Array.isArray(schema.anyOf)) {
    for (const [index, child] of schema.anyOf.entries()) {
      if (child && typeof child === 'object') {
        errors.push(...validateStrictSchema(child as JsonSchema, `${path}.anyOf[${index}]`));
      }
    }
  }
  return errors;
}

const string = (description: string, values?: string[]) => ({
  type: 'string',
  description,
  ...(values ? { enum: values } : {}),
});

const boolean = (description: string) => ({ type: 'boolean', description });
const number = (description: string, minimum?: number, maximum?: number) => ({
  type: 'number',
  description,
  ...(minimum !== undefined ? { minimum } : {}),
  ...(maximum !== undefined ? { maximum } : {}),
});

export class ToolRegistry {
  private readonly handlers = new Map<string, Handler>();
  private readonly toolDefinitions: ToolDefinition[] = [];

  constructor(
    private readonly database: Database,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly discord: DiscordToolPort,
    private readonly twitch?: TwitchToolPort,
    private readonly bridge?: BridgeToolPort,
  ) {
    this.registerTools();
  }

  definitions(): ToolDefinition[] {
    return this.toolDefinitions.map((definition) => structuredClone(definition));
  }

  definitionsForScene(scene: Scene): ToolDefinition[] {
    const voiceIntent = voiceControlToolForScene(scene);
    if (scene.current.platform !== 'discord_voice') {
      return this.toolDefinitions
        .filter((definition) => definition.name !== 'discord_join_voice' && definition.name !== 'discord_leave_voice'
          || definition.name === voiceIntent)
        .map((definition) => structuredClone(definition));
    }
    return this.toolDefinitions
      .filter((definition) => definition.name !== 'discord_join_voice' && definition.name !== 'discord_leave_voice'
        || definition.name === voiceIntent)
      .map((definition) => structuredClone(definition));
  }

  assertSchemasValid(): void {
    const failures: string[] = [];
    for (const definition of this.toolDefinitions) {
      const errors = validateStrictSchema(definition.parameters, definition.name);
      failures.push(...errors.map((error) => `${definition.name}: ${error}`));
    }
    if (failures.length > 0) {
      throw new Error(`Invalid strict OpenAI tool schemas:
${failures.join('\n')}`);
    }
  }

  toolNames(): string[] {
    return this.toolDefinitions.map((definition) => definition.name);
  }

  async resolveApprovalFromDashboard(input: {
    approvalId: string;
    approved: boolean;
    note?: string;
    context: ToolExecutionContext;
  }): Promise<ToolExecutionResult> {
    const approval = await this.database.getApproval(input.approvalId);
    if (!approval || approval.status !== 'pending') {
      return { ok: false, summary: 'That approval is missing or no longer pending.', errorCode: 'APPROVAL_NOT_PENDING' };
    }
    if (!input.approved) {
      const resolved = await this.database.resolveApproval({
        id: approval.id,
        status: 'denied',
        resolvedByPlatformUserId: input.context.currentEvent.actor.platformUserId,
        note: input.note ?? 'Denied from the Cinder dashboard.',
      });
      return resolved
        ? { ok: true, summary: 'The pending action was denied.' }
        : { ok: false, summary: 'That approval was already resolved.', errorCode: 'APPROVAL_NOT_PENDING' };
    }
    if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      await this.database.resolveApproval({
        id: approval.id,
        status: 'cancelled',
        resolvedByPlatformUserId: input.context.currentEvent.actor.platformUserId,
        note: 'Expired before dashboard approval.',
      });
      return { ok: false, summary: 'That approval expired.', errorCode: 'APPROVAL_EXPIRED' };
    }
    const handler = this.handlers.get(approval.toolName);
    if (!handler) {
      return { ok: false, summary: 'The approved tool is unavailable.', errorCode: 'TOOL_UNAVAILABLE' };
    }
    const result = await this.execute(approval.toolName, approval.toolArguments, input.context);
    await this.database.resolveApproval({
      id: approval.id,
      status: result.ok ? 'executed' : 'cancelled',
      resolvedByPlatformUserId: input.context.currentEvent.actor.platformUserId,
      note: input.note ?? result.summary,
    });
    return result;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const handler = this.handlers.get(name);
    let result: ToolExecutionResult;

    if (!handler) {
      result = { ok: false, summary: `Unknown tool: ${name}`, errorCode: 'UNKNOWN_TOOL' };
    } else {
      try {
        result = await handler(args, context);
      } catch (error) {
        this.logger.error({ err: error, tool: name, args }, 'Cinder tool execution crashed');
        result = {
          ok: false,
          summary: error instanceof Error ? error.message : String(error),
          errorCode: 'TOOL_EXECUTION_ERROR',
          retryable: false,
        };
      }
    }

    await this.database.recordAction({
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

  private add(definition: ToolDefinition, handler: Handler): void {
    this.toolDefinitions.push(definition);
    this.handlers.set(definition.name, handler);
  }


  private registerTools(): void {
    this.add(
      {
        type: 'function',
        name: 'stay_silent',
        description: 'Deliberately remain silent because speaking would not help the current social situation.',
        strict: true,
        parameters: objectSchema({ reason: string('A private short reason for the log.') }, ['reason']),
      },
      async (args) => ({ ok: true, summary: `Cinder stayed silent: ${String(args.reason ?? '')}` }),
    );

    this.addDiscordTools();
    this.addMemoryTools();
    this.addConfigurationTools();
    this.addApprovalTools();
    this.addIdentityTools();
    this.addTwitchTools();
    this.addBridgeTools();
  }

  private async mayReadHistory(context: ToolExecutionContext): Promise<boolean> {
    const serverId = context.currentEvent.serverId;
    if (!serverId) return false;
    const settings = await this.database.getGuildConfiguration(serverId);
    const actor = context.currentEvent.actor;
    return actor.isGuildOwner === true
      || actor.platformUserId === settings.ownerDiscordUserId
      || actor.roles.includes(settings.moderatorRoleName);
  }

  private messageIndexResult(events: import('@cinder/shared').EventEnvelope[]): Array<Record<string, unknown>> {
    return events.map((event) => ({
      messageRef: event.metadata.messageRef ?? event.metadata.messageId,
      channelRef: event.metadata.channelRef ?? event.channelId,
      author: event.actor.displayName,
      occurredAt: event.occurredAt,
      excerpt: event.text.slice(0, 240),
    }));
  }

  private addDiscordTools(): void {
    this.add(
      {
        type: 'function',
        name: 'discord_find_user_messages',
        description: 'Resolve a Discord channel and user, scan backward through channel history, and index that specific user’s messages. Use this instead of manually paging when asked for messages by a person. Moderator or owner only.',
        strict: true,
        parameters: objectSchema({
          channel_reference: string('Channel name, mention, ID, or scene resource reference. Unicode decoration and emoji may be omitted.'),
          user_reference: string('User mention, ID, username, or display name.'),
          query: string('Optional case-insensitive text fragment that each matching message must contain.'),
          scan_limit: number('How many recent channel messages to inspect, from 1 to 2000.', 1, 2000),
          result_limit: number('Maximum matching messages to return and index, from 1 to 100.', 1, 100),
        }, ['channel_reference', 'user_reference', 'scan_limit', 'result_limit']),
      },
      async (args, context) => {
        if (!await this.mayReadHistory(context)) {
          return { ok: false, summary: 'Only the configured moderator or server owner may search message history.', errorCode: 'NOT_AUTHORIZED' };
        }
        const serverId = context.currentEvent.serverId!;
        const found = await this.discord.findMessagesByUser({
          serverId,
          channelReference: z.string().parse(args.channel_reference),
          userReference: z.string().parse(args.user_reference),
          scanLimit: z.number().int().min(1).max(2000).parse(args.scan_limit),
          resultLimit: z.number().int().min(1).max(100).parse(args.result_limit),
          ...(typeof args.query === 'string' ? { query: args.query } : {}),
        });
        const settings = await this.database.getGuildConfiguration(serverId);
        if (settings.memoryExcludedChannelIds.includes(found.channelId)) {
          return { ok: false, summary: `#${found.channelName} is excluded from retained memory, so its history was not indexed.`, errorCode: 'MEMORY_EXCLUDED_CHANNEL' };
        }
        let indexed = 0;
        for (const event of found.events) if (await this.database.storeEvent(event)) indexed += 1;
        return {
          ok: true,
          summary: `Resolved #${found.channelName} and ${found.userName}; scanned ${found.scanned} messages, found ${found.events.length}, and indexed ${indexed} new matches.`,
          data: {
            channelRef: `discord:channel:${found.channelId}`,
            userRef: `discord:user:${found.userId}`,
            messages: this.messageIndexResult(found.events),
          },
        };
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_index_messages',
        description: 'Read a page of Discord channel history and index its message IDs and content so it can be searched or removed later. Moderator or owner only.',
        strict: true,
        parameters: objectSchema({
          channel_reference: string('Channel name, mention, ID, or scene resource reference.'),
          limit: number('Number of messages to read in this page, from 1 to 100.', 1, 100),
          before_message_reference: string('Optional message reference; index the page before it.'),
        }, ['channel_reference', 'limit']),
      },
      async (args, context) => {
        if (!await this.mayReadHistory(context)) {
          return { ok: false, summary: 'Only the configured moderator or server owner may index message history.', errorCode: 'NOT_AUTHORIZED' };
        }
        const serverId = context.currentEvent.serverId!;
        const events = await this.discord.fetchMessages({
          serverId,
          channelReference: z.string().parse(args.channel_reference),
          limit: z.number().int().min(1).max(100).parse(args.limit),
          ...(typeof args.before_message_reference === 'string'
            ? { beforeMessageReference: args.before_message_reference }
            : {}),
        });
        const settings = await this.database.getGuildConfiguration(serverId);
        const allowed = events.filter((event) => !event.channelId || !settings.memoryExcludedChannelIds.includes(event.channelId));
        let indexed = 0;
        for (const event of allowed) {
          if (await this.database.storeEvent(event)) indexed += 1;
        }
        return {
          ok: true,
          summary: `Read ${events.length} messages and indexed ${indexed} new messages${events.length !== allowed.length ? '; excluded private-memory channels were skipped' : ''}.`,
          data: { messages: this.messageIndexResult(allowed) },
        };
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_search_indexed_messages',
        description: 'Search indexed Discord messages and return exact message references suitable for later moderation or deletion. Moderator or owner only.',
        strict: true,
        parameters: objectSchema({
          query: string('Optional text fragment to find.'),
          channel_reference: string('Optional channel to restrict the search.'),
          author_reference: string('Optional author ID, username, or display-name fragment.'),
          limit: number('Maximum matches, from 1 to 50.', 1, 50),
        }, ['limit']),
      },
      async (args, context) => {
        if (!await this.mayReadHistory(context)) {
          return { ok: false, summary: 'Only the configured moderator or server owner may search indexed messages.', errorCode: 'NOT_AUTHORIZED' };
        }
        const serverId = context.currentEvent.serverId!;
        const channelId = typeof args.channel_reference === 'string'
          ? await this.discord.resolveChannelId(serverId, args.channel_reference)
          : undefined;
        if (typeof args.channel_reference === 'string' && !channelId) {
          return { ok: false, summary: 'I could not resolve that channel.', errorCode: 'CHANNEL_NOT_FOUND' };
        }
        const events = await this.database.searchDiscordMessages({
          serverId,
          ...(typeof args.query === 'string' ? { query: args.query } : {}),
          ...(channelId ? { channelId } : {}),
          ...(typeof args.author_reference === 'string' ? { authorReference: args.author_reference } : {}),
          limit: z.number().int().min(1).max(50).parse(args.limit),
        });
        return { ok: true, summary: `Found ${events.length} indexed messages.`, data: { messages: this.messageIndexResult(events) } };
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_send_message',
        description: 'Send a message to a Discord channel other than the automatic current-channel response.',
        strict: true,
        parameters: objectSchema({
          channel_reference: string('Channel name, mention, ID, or scene resource reference.'),
          text: string('Message text.'),
          reply_to_message_reference: string('Optional message ID or scene resource reference.'),
        }, ['channel_reference', 'text']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        const channelReference = z.string().parse(args.channel_reference);
        const destinationChannelId = await this.discord.resolveChannelId(serverId, channelReference);
        if (!destinationChannelId) {
          return { ok: false, summary: 'I could not resolve that channel.', errorCode: 'CHANNEL_NOT_FOUND' };
        }
        if (destinationChannelId === context.currentEvent.channelId) {
          return {
            ok: false,
            summary: 'Do not use discord_send_message for the current channel. Return the reply as the final response so the runtime delivers it exactly once.',
            errorCode: 'CURRENT_CHANNEL_AUTO_DELIVERY',
          };
        }
        return this.discord.sendMessage({
          serverId,
          channelReference: destinationChannelId,
          text: z.string().min(1).parse(args.text),
          ...(typeof args.reply_to_message_reference === 'string'
            ? { replyToMessageReference: args.reply_to_message_reference }
            : {}),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_react',
        description: 'Add an emoji reaction to a Discord message.',
        strict: true,
        parameters: objectSchema({
          channel_reference: string('Channel containing the message.'),
          message_reference: string('Message ID, reply target, or scene resource reference.'),
          emoji: string('Unicode emoji or custom emoji representation.'),
        }, ['channel_reference', 'message_reference', 'emoji']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.addReaction({
          serverId,
          channelReference: z.string().parse(args.channel_reference),
          messageReference: z.string().parse(args.message_reference),
          emoji: z.string().parse(args.emoji),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_create_channel',
        description: 'Create a Discord text, voice, forum, or category channel.',
        strict: true,
        parameters: objectSchema({
          name: string('Lowercase channel name or category name.'),
          kind: string('Channel kind.', ['text', 'voice', 'category', 'forum']),
          category_reference: string('Optional parent category name or scene reference.'),
          topic: string('Optional topic for text or forum channels.'),
        }, ['name', 'kind']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.createChannel({
          serverId,
          name: z.string().min(1).max(100).parse(args.name),
          kind: z.enum(['text', 'voice', 'category', 'forum']).parse(args.kind),
          ...(typeof args.category_reference === 'string' ? { categoryReference: args.category_reference } : {}),
          ...(typeof args.topic === 'string' ? { topic: args.topic } : {}),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_rename_channel',
        description: 'Rename a Discord channel or category.',
        strict: true,
        parameters: objectSchema({
          channel_reference: string('Channel name, mention, ID, or scene resource reference.'),
          new_name: string('New channel name.'),
        }, ['channel_reference', 'new_name']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.renameChannel({
          serverId,
          channelReference: z.string().parse(args.channel_reference),
          newName: z.string().min(1).max(100).parse(args.new_name),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_move_channel',
        description: 'Move a Discord channel into or out of a category and optionally set its position.',
        strict: true,
        parameters: objectSchema({
          channel_reference: string('Channel to move.'),
          category_reference: string('Destination category. Use "none" to remove the parent.'),
          position: number('Optional zero-based channel position.', 0, 500),
        }, ['channel_reference']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.moveChannel({
          serverId,
          channelReference: z.string().parse(args.channel_reference),
          ...(typeof args.category_reference === 'string' ? { categoryReference: args.category_reference } : {}),
          ...(typeof args.position === 'number' ? { position: z.number().int().min(0).parse(args.position) } : {}),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_delete_channel',
        description: 'Delete a Discord channel or category. Use approval first when deletion is broad, active, or difficult to reverse.',
        strict: true,
        parameters: objectSchema({
          channel_reference: string('Channel name, mention, ID, or scene resource reference.'),
          reason: string('Short audit reason.'),
        }, ['channel_reference']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.deleteChannel({
          serverId,
          channelReference: z.string().parse(args.channel_reference),
          ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_set_channel_read_only',
        description: 'Make a channel read-only or writable for @everyone or a named role.',
        strict: true,
        parameters: objectSchema({
          channel_reference: string('Channel to change.'),
          read_only: boolean('True to deny sending messages; false to restore sending.'),
          role_reference: string('Optional role name, mention, ID, or scene reference. Defaults to @everyone.'),
        }, ['channel_reference', 'read_only']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.setChannelReadOnly({
          serverId,
          channelReference: z.string().parse(args.channel_reference),
          readOnly: z.boolean().parse(args.read_only),
          ...(typeof args.role_reference === 'string' ? { roleReference: args.role_reference } : {}),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_delete_message',
        description: 'Delete a specific Discord message resolved from the reply chain or scene.',
        strict: true,
        parameters: objectSchema({
          channel_reference: string('Channel containing the message.'),
          message_reference: string('Message ID, reply target, or scene resource reference.'),
          reason: string('Short audit reason.'),
        }, ['channel_reference', 'message_reference']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.deleteMessage({
          serverId,
          channelReference: z.string().parse(args.channel_reference),
          messageReference: z.string().parse(args.message_reference),
          ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_pin_message',
        description: 'Pin or unpin a Discord message.',
        strict: true,
        parameters: objectSchema({
          channel_reference: string('Channel containing the message.'),
          message_reference: string('Message ID, reply target, or scene resource reference.'),
          pin: boolean('True to pin, false to unpin.'),
        }, ['channel_reference', 'message_reference', 'pin']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.pinMessage({
          serverId,
          channelReference: z.string().parse(args.channel_reference),
          messageReference: z.string().parse(args.message_reference),
          pin: z.boolean().parse(args.pin),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_timeout_member',
        description: 'Apply or clear a Discord communication timeout.',
        strict: true,
        parameters: objectSchema({
          user_reference: string('User mention, ID, display name, or scene resource reference.'),
          minutes: number('Timeout length in minutes. Use 0 to clear.', 0, 40320),
          reason: string('Short audit reason.'),
        }, ['user_reference', 'minutes']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.timeoutMember({
          serverId,
          userReference: z.string().parse(args.user_reference),
          minutes: z.number().int().min(0).max(40320).parse(args.minutes),
          ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_ban_member',
        description: 'Ban a Discord member. Consider approval for permanent or disputed bans.',
        strict: true,
        parameters: objectSchema({
          user_reference: string('User mention, ID, display name, or scene resource reference.'),
          reason: string('Short audit reason.'),
          delete_message_seconds: number('Seconds of recent messages to remove, from 0 to 604800.', 0, 604800),
        }, ['user_reference']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.banMember({
          serverId,
          userReference: z.string().parse(args.user_reference),
          ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
          ...(typeof args.delete_message_seconds === 'number'
            ? { deleteMessageSeconds: z.number().int().min(0).max(604800).parse(args.delete_message_seconds) }
            : {}),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_create_role',
        description: 'Create a Discord role without assigning dangerous permissions by default.',
        strict: true,
        parameters: objectSchema({
          name: string('Role name.'),
          color: string('Optional hexadecimal color such as #7c3aed.'),
          mentionable: boolean('Whether members can mention the role.'),
          hoist: boolean('Whether the role appears separately in the member list.'),
        }, ['name']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.createRole({
          serverId,
          name: z.string().min(1).max(100).parse(args.name),
          ...(typeof args.color === 'string' ? { color: args.color } : {}),
          ...(typeof args.mentionable === 'boolean' ? { mentionable: args.mentionable } : {}),
          ...(typeof args.hoist === 'boolean' ? { hoist: args.hoist } : {}),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_assign_role',
        description: 'Assign or remove an existing Discord role from a member.',
        strict: true,
        parameters: objectSchema({
          user_reference: string('User mention, ID, display name, or scene resource reference.'),
          role_reference: string('Role name, mention, ID, or scene resource reference.'),
          assign: boolean('True to assign, false to remove.'),
        }, ['user_reference', 'role_reference', 'assign']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.assignRole({
          serverId,
          userReference: z.string().parse(args.user_reference),
          roleReference: z.string().parse(args.role_reference),
          assign: z.boolean().parse(args.assign),
        });
      },
    );

    this.add(
      {
        type: 'function',
        name: 'discord_join_voice',
        description: 'Join the current requester’s Discord voice channel or a specifically referenced voice channel.',
        strict: true,
        parameters: objectSchema({
          channel_reference: string('Optional voice channel name, mention, ID, or scene reference.'),
        }),
      },
      async (args, context) => this.discord.joinVoice({
        event: context.currentEvent,
        ...(typeof args.channel_reference === 'string' ? { channelReference: args.channel_reference } : {}),
      }),
    );

    this.add(
      {
        type: 'function',
        name: 'discord_leave_voice',
        description: 'Leave the active Discord voice channel in the current server.',
        strict: true,
        parameters: objectSchema({}),
      },
      async (_args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        return this.discord.leaveVoice({ serverId });
      },
    );
  }

  private addMemoryTools(): void {
    this.add(
      {
        type: 'function',
        name: 'remember',
        description: 'Store a useful long-term memory with an explicit audience scope.',
        strict: true,
        parameters: objectSchema({
          content: string('Concise fact, preference, relationship note, promise, configuration, or meaningful episode.'),
          scope: string('Audience scope.', [
            'senti_private',
            'moderator_private',
            'discord_public',
            'twitch_public',
            'cross_platform_safe',
            'voice_session',
            'temporary',
          ]),
          kind: string('Memory kind.', [
            'person', 'episode', 'self', 'promise', 'preference', 'relationship', 'configuration',
          ]),
          importance: number('Importance from 0 to 100.', 0, 100),
          about_current_person: boolean('Whether this memory belongs to the current speaker.'),
          expires_at: string('Optional ISO-8601 expiration timestamp.'),
        }, ['content', 'scope', 'kind', 'importance', 'about_current_person']),
      },
      async (args, context) => {
        const memory = await this.database.saveMemory({
          ...(args.about_current_person === true && context.currentEvent.actor.personId
            ? { personId: context.currentEvent.actor.personId }
            : {}),
          ...(context.currentEvent.serverId ? { serverId: context.currentEvent.serverId } : {}),
          scope: z.enum([
            'senti_private', 'moderator_private', 'discord_public', 'twitch_public',
            'cross_platform_safe', 'voice_session', 'temporary',
          ]).parse(args.scope) as AudienceScope,
          kind: z.enum([
            'person', 'episode', 'self', 'promise', 'preference', 'relationship', 'configuration',
          ]).parse(args.kind),
          content: z.string().min(1).max(4000).parse(args.content),
          importance: z.number().int().min(0).max(100).parse(args.importance),
          ...(typeof args.expires_at === 'string' ? { expiresAt: args.expires_at } : {}),
        });
        return { ok: true, summary: 'Memory stored.', data: { memoryId: memory.id } };
      },
    );

    this.add(
      {
        type: 'function',
        name: 'forget_memory',
        description: 'Delete a specific memory shown in the scene when asked to forget it.',
        strict: true,
        parameters: objectSchema({ memory_id: string('Exact memory ID from the scene.') }, ['memory_id']),
      },
      async (args) => {
        const removed = await this.database.deleteMemory(z.string().parse(args.memory_id));
        return removed
          ? { ok: true, summary: 'Memory forgotten.' }
          : { ok: false, summary: 'That memory no longer exists.', errorCode: 'MEMORY_NOT_FOUND' };
      },
    );
  }

  private addConfigurationTools(): void {
    this.add(
      {
        type: 'function',
        name: 'configure_cinder',
        description: 'Change Cinder’s natural server configuration, such as moderator role or optional approval channel.',
        strict: true,
        parameters: objectSchema({
          moderator_role_reference: string('Optional moderator role name, mention, ID, or scene reference.'),
          bot_admin_channel_reference: string('Optional channel name, mention, ID, or scene reference for approval requests.'),
          clear_bot_admin_channel: boolean('True to stop routing approval requests to a special channel.'),
          voice_join_role_reference: string('Optional role allowed to ask Cinder to join voice.'),
          quiet_channel_reference: string('Optional channel where Cinder should stop listening entirely.'),
          resume_channel_reference: string('Optional channel where Cinder should resume listening.'),
          memory_excluded_channel_reference: string('Optional channel whose conversation should not become long-term memory.'),
          memory_allowed_channel_reference: string('Optional channel to remove from the memory exclusion list.'),
        }),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'No Discord server is active.', errorCode: 'NO_SERVER' };
        const current = await this.database.getGuildConfiguration(serverId);
        const next: GuildConfiguration = { ...current };

        if (typeof args.moderator_role_reference === 'string') {
          const roleName = await this.discord.resolveRoleName(serverId, args.moderator_role_reference);
          if (!roleName) return { ok: false, summary: 'I could not resolve that moderator role.', errorCode: 'ROLE_NOT_FOUND' };
          next.moderatorRoleName = roleName;
        }

        if (args.clear_bot_admin_channel === true) delete next.botAdminChannelId;

        if (typeof args.bot_admin_channel_reference === 'string') {
          const channelId = await this.discord.resolveChannelId(serverId, args.bot_admin_channel_reference);
          if (!channelId) return { ok: false, summary: 'I could not resolve that bot-admin channel.', errorCode: 'CHANNEL_NOT_FOUND' };
          next.botAdminChannelId = channelId;
        }

        if (typeof args.voice_join_role_reference === 'string') {
          const roleName = await this.discord.resolveRoleName(serverId, args.voice_join_role_reference);
          if (!roleName) return { ok: false, summary: 'I could not resolve that voice-access role.', errorCode: 'ROLE_NOT_FOUND' };
          next.voiceJoinRoleName = roleName;
        }

        if (typeof args.quiet_channel_reference === 'string') {
          const channelId = await this.discord.resolveChannelId(serverId, args.quiet_channel_reference);
          if (!channelId) return { ok: false, summary: 'I could not resolve the channel to quiet.', errorCode: 'CHANNEL_NOT_FOUND' };
          next.quietChannelIds = [...new Set([...next.quietChannelIds, channelId])];
        }

        if (typeof args.resume_channel_reference === 'string') {
          const channelId = await this.discord.resolveChannelId(serverId, args.resume_channel_reference);
          if (!channelId) return { ok: false, summary: 'I could not resolve the channel to resume.', errorCode: 'CHANNEL_NOT_FOUND' };
          next.quietChannelIds = next.quietChannelIds.filter((id) => id !== channelId);
        }

        if (typeof args.memory_excluded_channel_reference === 'string') {
          const channelId = await this.discord.resolveChannelId(serverId, args.memory_excluded_channel_reference);
          if (!channelId) return { ok: false, summary: 'I could not resolve the memory-excluded channel.', errorCode: 'CHANNEL_NOT_FOUND' };
          next.memoryExcludedChannelIds = [...new Set([...next.memoryExcludedChannelIds, channelId])];
        }

        if (typeof args.memory_allowed_channel_reference === 'string') {
          const channelId = await this.discord.resolveChannelId(serverId, args.memory_allowed_channel_reference);
          if (!channelId) return { ok: false, summary: 'I could not resolve the memory-allowed channel.', errorCode: 'CHANNEL_NOT_FOUND' };
          next.memoryExcludedChannelIds = next.memoryExcludedChannelIds.filter((id) => id !== channelId);
        }

        await this.database.saveGuildConfiguration(next);
        return {
          ok: true,
          summary: 'Cinder configuration updated.',
          data: {
            moderatorRoleName: next.moderatorRoleName,
            botAdminChannelId: next.botAdminChannelId ?? null,
            voiceJoinRoleName: next.voiceJoinRoleName ?? null,
            quietChannelIds: next.quietChannelIds,
            memoryExcludedChannelIds: next.memoryExcludedChannelIds,
          },
        };
      },
    );
  }

  private addApprovalTools(): void {
    this.add(
      {
        type: 'function',
        name: 'request_approval',
        description: 'Ask for approval before a consequential tool action. Store the exact intended tool and arguments.',
        strict: true,
        parameters: objectSchema({
          description: string('Human-readable description of exactly what will happen.'),
          tool_name: string('Exact tool to execute after approval.'),
          tool_arguments_json: string('JSON object containing the exact arguments for that tool.'),
          ttl_minutes: number('How long the approval stays valid.', 1, 1440),
        }, ['description', 'tool_name', 'tool_arguments_json', 'ttl_minutes']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        const originChannelId = context.currentEvent.channelId;
        if (!serverId || !originChannelId) {
          return { ok: false, summary: 'Approval routing requires an active Discord server channel.', errorCode: 'NO_DISCORD_ORIGIN' };
        }
        const toolName = z.string().parse(args.tool_name);
        if (['request_approval', 'execute_approved_action', 'cancel_pending_action', 'stay_silent'].includes(toolName)) {
          return { ok: false, summary: 'That tool cannot be placed inside an approval.', errorCode: 'INVALID_APPROVAL_TOOL' };
        }
        if (!this.handlers.has(toolName)) {
          return { ok: false, summary: `Unknown approval tool: ${toolName}`, errorCode: 'UNKNOWN_TOOL' };
        }

        let toolArguments: Record<string, unknown>;
        try {
          toolArguments = JSON.parse(z.string().parse(args.tool_arguments_json)) as Record<string, unknown>;
        } catch {
          return { ok: false, summary: 'Approval arguments were not valid JSON.', errorCode: 'INVALID_APPROVAL_ARGUMENTS' };
        }

        const guildConfig = await this.database.getGuildConfiguration(serverId);
        const approval = await this.database.createApproval({
          serverId,
          requestedByPlatformUserId: context.currentEvent.actor.platformUserId,
          requestedByName: context.currentEvent.actor.displayName,
          description: z.string().min(1).parse(args.description),
          toolName,
          toolArguments,
          originChannelId,
          ...(guildConfig.botAdminChannelId ? { approvalChannelId: guildConfig.botAdminChannelId } : {}),
          ttlMinutes: z.number().int().min(1).max(1440).parse(args.ttl_minutes),
        });

        const destination = guildConfig.botAdminChannelId ?? originChannelId;
        const message = [
          `Approval needed: ${approval.description}`,
          `Requested by ${approval.requestedByName}.`,
          'Reply naturally with approval or denial. I will keep the original context attached.',
        ].join('\n');
        const delivery = await this.discord.sendMessage({
          serverId,
          channelReference: destination,
          text: message,
        });

        return delivery.ok
          ? {
              ok: true,
              summary: guildConfig.botAdminChannelId
                ? 'Approval request sent to the configured bot-admin channel.'
                : 'Approval requested in the current channel.',
              data: { approvalId: approval.id, destinationChannelId: destination },
            }
          : delivery;
      },
    );

    this.add(
      {
        type: 'function',
        name: 'execute_approved_action',
        description: 'Execute a pending approved action after the same Cinder has received clear approval in context.',
        strict: true,
        parameters: objectSchema({
          approval_id: string('Approval reference from the scene.'),
          approval_note: string('Short note describing the approval received.'),
        }, ['approval_id']),
      },
      async (args, context) => {
        const approvalId = z.string().parse(args.approval_id);
        const approval = await this.database.getApproval(approvalId);
        if (!approval || approval.status !== 'pending') {
          return { ok: false, summary: 'That approval is missing or no longer pending.', errorCode: 'APPROVAL_NOT_PENDING' };
        }
        if (new Date(approval.expiresAt).getTime() <= Date.now()) {
          await this.database.resolveApproval({
            id: approvalId,
            status: 'cancelled',
            resolvedByPlatformUserId: context.currentEvent.actor.platformUserId,
            note: 'Expired before execution.',
          });
          return { ok: false, summary: 'That approval expired.', errorCode: 'APPROVAL_EXPIRED' };
        }
        const handler = this.handlers.get(approval.toolName);
        if (!handler) return { ok: false, summary: 'The approved tool is unavailable.', errorCode: 'TOOL_UNAVAILABLE' };

        const result = await handler(approval.toolArguments, context);
        await this.database.resolveApproval({
          id: approvalId,
          status: result.ok ? 'executed' : 'cancelled',
          resolvedByPlatformUserId: context.currentEvent.actor.platformUserId,
          note: typeof args.approval_note === 'string' ? args.approval_note : result.summary,
        });
        return result;
      },
    );
    this.add(
      {
        type: 'function',
        name: 'cancel_pending_action',
        description: 'Deny or cancel a pending approval after the same Cinder receives a clear denial or cancellation.',
        strict: true,
        parameters: objectSchema({
          approval_id: string('Approval reference from the scene.'),
          reason: string('Short reason for denial or cancellation.'),
        }, ['approval_id']),
      },
      async (args, context) => {
        const resolved = await this.database.resolveApproval({
          id: z.string().parse(args.approval_id),
          status: 'denied',
          resolvedByPlatformUserId: context.currentEvent.actor.platformUserId,
          ...(typeof args.reason === 'string' ? { note: args.reason } : {}),
        });
        return resolved
          ? { ok: true, summary: 'The pending action was cancelled.' }
          : { ok: false, summary: 'That approval is missing or no longer pending.', errorCode: 'APPROVAL_NOT_PENDING' };
      },
    );
  }

  private addIdentityTools(): void {
    this.add(
      {
        type: 'function',
        name: 'link_person_identities',
        description: 'Link a naturally referenced Discord member and known Twitch chatter only after explicit confirmation in the scene.',
        strict: true,
        parameters: objectSchema({
          discord_user_reference: string('Discord mention, display name, username, ID, or scene resource reference.'),
          twitch_user_reference: string('Known Twitch display name, login, or internal scene user ID.'),
          confirmation_basis: string('Short description of the explicit confirmation.'),
        }, ['discord_user_reference', 'twitch_user_reference', 'confirmation_basis']),
      },
      async (args, context) => {
        const serverId = context.currentEvent.serverId;
        if (!serverId) return { ok: false, summary: 'Discord identity linking needs an active server.', errorCode: 'NO_SERVER' };
        const discordIdentity = await this.discord.resolveUserIdentity(serverId, z.string().parse(args.discord_user_reference));
        if (!discordIdentity) return { ok: false, summary: 'I could not unambiguously resolve that Discord member.', errorCode: 'DISCORD_IDENTITY_AMBIGUOUS' };
        await this.database.ensureIdentity({
          platform: 'discord',
          platformUserId: discordIdentity.id,
          displayName: discordIdentity.displayName,
          username: discordIdentity.username,
          roles: [],
          isBot: false,
        });
        const twitch = await this.database.resolveIdentity('twitch', z.string().parse(args.twitch_user_reference));
        if (!twitch) return { ok: false, summary: 'I could not unambiguously resolve that known Twitch chatter.', errorCode: 'TWITCH_IDENTITY_AMBIGUOUS' };
        const personId = await this.database.linkIdentities({
          sourcePlatform: 'discord',
          sourceUserId: discordIdentity.id,
          targetPlatform: 'twitch',
          targetUserId: twitch.platformUserId,
          verified: true,
        });
        return {
          ok: true,
          summary: `Linked the Discord member with Twitch user ${twitch.displayName}.`,
          data: { personId, discordUserId: discordIdentity.id, twitchUserId: twitch.platformUserId },
        };
      },
    );
  }

  private addTwitchTools(): void {
    if (!this.twitch) return;

    this.add(
      {
        type: 'function',
        name: 'twitch_send_message',
        description: 'Send a Twitch chat message or reply to a specific Twitch message.',
        strict: true,
        parameters: objectSchema({
          text: string('Chat message.'),
          reply_parent_message_id: string('Optional Twitch message ID to reply to.'),
        }, ['text']),
      },
      async (args) => this.twitch!.sendMessage({
        text: z.string().min(1).max(500).parse(args.text),
        ...(typeof args.reply_parent_message_id === 'string'
          ? { replyParentMessageId: args.reply_parent_message_id }
          : {}),
      }),
    );

    this.add(
      {
        type: 'function',
        name: 'twitch_delete_message',
        description: 'Delete a specific Twitch chat message.',
        strict: true,
        parameters: objectSchema({ message_id: string('Twitch message ID from the scene.') }, ['message_id']),
      },
      async (args) => this.twitch!.deleteMessage({ messageId: z.string().parse(args.message_id) }),
    );

    this.add(
      {
        type: 'function',
        name: 'twitch_timeout_user',
        description: 'Timeout a Twitch chatter.',
        strict: true,
        parameters: objectSchema({
          user_id: string('Twitch user ID from the scene.'),
          seconds: number('Timeout duration in seconds.', 1, 1209600),
          reason: string('Moderation reason.'),
        }, ['user_id', 'seconds']),
      },
      async (args) => this.twitch!.timeoutUser({
        userId: z.string().parse(args.user_id),
        seconds: z.number().int().min(1).max(1209600).parse(args.seconds),
        ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
      }),
    );

    this.add(
      {
        type: 'function',
        name: 'twitch_ban_user',
        description: 'Permanently ban a Twitch chatter. Consider approval for disputed cases.',
        strict: true,
        parameters: objectSchema({
          user_id: string('Twitch user ID from the scene.'),
          reason: string('Moderation reason.'),
        }, ['user_id']),
      },
      async (args) => this.twitch!.banUser({
        userId: z.string().parse(args.user_id),
        ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
      }),
    );

    this.add(
      {
        type: 'function',
        name: 'twitch_warn_user',
        description: 'Send a formal Twitch moderation warning.',
        strict: true,
        parameters: objectSchema({
          user_id: string('Twitch user ID from the scene.'),
          reason: string('Warning reason.'),
        }, ['user_id', 'reason']),
      },
      async (args) => this.twitch!.warnUser({
        userId: z.string().parse(args.user_id),
        reason: z.string().min(1).parse(args.reason),
      }),
    );
  }

  private addBridgeTools(): void {
    if (!this.bridge) return;

    const actions = [
      'play_song', 'pause_media', 'resume_media', 'stop_media', 'set_volume',
      'open_application', 'obs_scene', 'obs_stream_start', 'obs_stream_stop',
    ];

    this.add(
      {
        type: 'function',
        name: 'windows_action',
        description: 'Use Cinder’s connected Windows hands for media, known songs, applications, or OBS.',
        strict: true,
        parameters: objectSchema({
          action: string('Windows action.', actions),
          arguments_json: string('JSON object with action-specific arguments.'),
        }, ['action', 'arguments_json']),
      },
      async (args) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(z.string().parse(args.arguments_json)) as Record<string, unknown>;
        } catch {
          return { ok: false, summary: 'Windows action arguments were not valid JSON.', errorCode: 'INVALID_ARGUMENTS' };
        }
        return this.bridge!.sendCommand({
          action: z.enum(actions as [string, ...string[]]).parse(args.action),
          arguments: parsed,
        });
      },
    );
  }
}
