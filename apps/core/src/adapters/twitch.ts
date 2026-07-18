import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { ActorIdentity, EventEnvelope, ToolExecutionResult } from '@cinder/shared';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { Database } from '../db/database.js';
import type { TwitchToolPort } from '../tools/ports.js';

type ConnectionKind = 'chat' | 'events';
type TokenKind = 'bot' | 'broadcaster';

interface TwitchEnvelope {
  metadata: {
    message_id: string;
    message_type: string;
    message_timestamp: string;
    subscription_type?: string;
  };
  payload: {
    session?: { id: string; status: string; keepalive_timeout_seconds?: number; reconnect_url?: string };
    subscription?: { type: string; version: string };
    event?: Record<string, unknown>;
  };
}

interface ChatEntry {
  externalMessageId: string;
  occurredAt: string;
  actor: ActorIdentity;
  text: string;
  replyParentMessageId?: string;
  replyToCinder: boolean;
  badges: Array<{ set_id?: string; id?: string; info?: string }>;
}

interface TokenState {
  accessToken: string;
  refreshToken: string;
}

interface ConnectionState {
  kind: ConnectionKind;
  tokenKind: TokenKind;
  socket: WebSocket | undefined;
  reconnectTimer: NodeJS.Timeout | undefined;
  healthTimer: NodeJS.Timeout | undefined;
  reconnectAttempt: number;
  lastEventAt: number;
  ready: boolean;
  preserveSubscriptionsOnWelcome: boolean;
}

interface TwitchValidation {
  client_id: string;
  login: string;
  scopes: string[];
  user_id: string;
  expires_in: number;
}

const DEFAULT_EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

function isDirectCinderAddress(text: string): boolean {
  return /(?:^|\W)@?cinder(?:_ai)?(?:\W|$)/i.test(text);
}

function isHighConfidenceConductProblem(text: string): boolean {
  return /\b(?:kill yourself|kys|go die|doxx?(?:ed|ing)?|swatt?(?:ed|ing)?|i(?:'ll| will) (?:hurt|kill|find) you)\b/i.test(text)
    || /\byou(?:'re| are) (?:a |an )?(?:worthless|disgusting|idiot|moron|loser)\b/i.test(text);
}

const BOT_REQUIRED_SCOPES = [
  'user:bot',
  'user:read:chat',
  'user:write:chat',
  'moderator:manage:chat_messages',
  'moderator:manage:banned_users',
  'moderator:manage:warnings',
];

const BROADCASTER_REQUIRED_SCOPES = [
  'channel:bot',
  'channel:read:subscriptions',
  'bits:read',
  'channel:read:redemptions',
  'moderator:read:followers',
];

export function describeTwitchNotification(type: string, event: Record<string, unknown>): string {
  const name = String(event.user_name ?? event.from_broadcaster_user_name ?? 'Someone');
  switch (type) {
    case 'channel.follow': return `${name} followed the channel.`;
    case 'channel.subscribe': return `${name} subscribed to the channel.`;
    case 'channel.subscription.message': return `${name} sent a subscription message.`;
    case 'channel.subscription.gift': return `${name} gifted ${String(event.total ?? event.cumulative_total ?? '')} subscription${Number(event.total ?? 0) === 1 ? '' : 's'}.`;
    case 'channel.cheer': return `${name} cheered ${String(event.bits ?? '')} bits.`;
    case 'channel.raid': return `${name} raided with ${String(event.viewers ?? '')} viewers.`;
    case 'channel.channel_points_custom_reward_redemption.add': return `${name} redeemed ${String((event.reward as Record<string, unknown> | undefined)?.title ?? 'a channel reward')}.`;
    case 'stream.online': return 'The Twitch stream went live.';
    case 'stream.offline': return 'The Twitch stream went offline.';
    case 'channel.update': return `The Twitch channel was updated: ${String(event.title ?? 'new channel details')}.`;
    default: return `Twitch event ${type}: ${JSON.stringify(event)}`;
  }
}

export function twitchReplyParentMessageId(event: EventEnvelope): string | undefined {
  if (event.metadata.suppressReply === true) return undefined;

  const batch = Array.isArray(event.metadata.chatBatch)
    ? event.metadata.chatBatch as Array<Record<string, unknown>>
    : [];

  return batch.length === 1 && typeof batch[0]?.messageId === 'string'
    ? batch[0].messageId
    : undefined;
}

export class TwitchAdapter implements TwitchToolPort {
  private readonly connections: Record<ConnectionKind, ConnectionState> = {
    chat: {
      kind: 'chat',
      tokenKind: 'bot',
      socket: undefined,
      reconnectTimer: undefined,
      healthTimer: undefined,
      reconnectAttempt: 0,
      lastEventAt: Date.now(),
      ready: false,
      preserveSubscriptionsOnWelcome: false,
    },
    events: {
      kind: 'events',
      tokenKind: 'broadcaster',
      socket: undefined,
      reconnectTimer: undefined,
      healthTimer: undefined,
      reconnectAttempt: 0,
      lastEventAt: Date.now(),
      ready: false,
      preserveSubscriptionsOnWelcome: false,
    },
  };

  private readonly tokens: Record<TokenKind, TokenState>;
  private stopped = false;
  private chatBuffer: ChatEntry[] = [];
  private chatTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly database: Database,
    private readonly emitEvent: (event: EventEnvelope) => Promise<void>,
  ) {
    this.tokens = {
      bot: {
        accessToken: config.TWITCH_BOT_ACCESS_TOKEN ?? '',
        refreshToken: config.TWITCH_BOT_REFRESH_TOKEN ?? '',
      },
      broadcaster: {
        accessToken: config.TWITCH_BROADCASTER_ACCESS_TOKEN ?? '',
        refreshToken: config.TWITCH_BROADCASTER_REFRESH_TOKEN ?? '',
      },
    };
  }

  async start(): Promise<void> {
    if (!this.config.TWITCH_ENABLED) return;

    for (const kind of ['bot', 'broadcaster'] as const) {
      const saved = await this.database.getRuntimeState<{ accessToken?: string; refreshToken?: string }>(`twitch_${kind}_tokens`);
      if (saved?.accessToken) this.tokens[kind].accessToken = saved.accessToken;
      if (saved?.refreshToken) this.tokens[kind].refreshToken = saved.refreshToken;
      await this.validateToken(kind);
    }

    this.stopped = false;
    await Promise.all([
      this.connect(this.connections.chat, DEFAULT_EVENTSUB_URL, false),
      this.connect(this.connections.events, DEFAULT_EVENTSUB_URL, false),
    ]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.chatTimer) clearTimeout(this.chatTimer);
    await this.flushChat();

    for (const state of Object.values(this.connections)) {
      state.ready = false;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      if (state.healthTimer) clearInterval(state.healthTimer);
      state.socket?.close(1000, 'Cinder shutting down');
    }
  }

  isReady(): boolean {
    return !this.config.TWITCH_ENABLED
      || (this.connections.chat.ready && this.connections.events.ready);
  }

  async deliver(event: EventEnvelope, text: string): Promise<ToolExecutionResult> {
    if (!text.trim()) return { ok: true, summary: 'No Twitch response was needed.' };
    const replyId = twitchReplyParentMessageId(event);
    return this.sendMessage({ text, ...(replyId ? { replyParentMessageId: replyId } : {}) });
  }

  async getPlatformState(): Promise<Record<string, unknown>> {
    return {
      platform: 'twitch',
      connected: this.isReady(),
      chatConnected: this.connections.chat.ready,
      eventsConnected: this.connections.events.ready,
      broadcasterId: this.config.TWITCH_BROADCASTER_ID,
      botUserId: this.config.TWITCH_BOT_USER_ID,
      bufferedMessages: this.chatBuffer.length,
    };
  }

  async sendMessage(input: { text: string; replyParentMessageId?: string }): Promise<ToolExecutionResult> {
    const body = {
      broadcaster_id: this.config.TWITCH_BROADCASTER_ID,
      sender_id: this.config.TWITCH_BOT_USER_ID,
      message: input.text.slice(0, 500),
      ...(input.replyParentMessageId ? { reply_parent_message_id: input.replyParentMessageId } : {}),
    };
    const response = await this.helix('/chat/messages', { method: 'POST', body: JSON.stringify(body) }, 'bot');
    if (!response.ok) return this.apiFailure('Twitch rejected the chat message.', response);
    return { ok: true, summary: 'Sent a Twitch chat message.' };
  }

  async deleteMessage(input: { messageId: string }): Promise<ToolExecutionResult> {
    const query = new URLSearchParams({
      broadcaster_id: this.config.TWITCH_BROADCASTER_ID!,
      moderator_id: this.config.TWITCH_BOT_USER_ID!,
      message_id: input.messageId,
    });
    const response = await this.helix(`/moderation/chat?${query}`, { method: 'DELETE' }, 'bot');
    if (!response.ok) return this.apiFailure('Twitch refused to delete that message.', response);
    return { ok: true, summary: 'Deleted the Twitch message.' };
  }

  async timeoutUser(input: { userId: string; seconds: number; reason?: string }): Promise<ToolExecutionResult> {
    return this.banRequest(input.userId, input.reason, input.seconds);
  }

  async banUser(input: { userId: string; reason?: string }): Promise<ToolExecutionResult> {
    return this.banRequest(input.userId, input.reason);
  }

  async warnUser(input: { userId: string; reason: string }): Promise<ToolExecutionResult> {
    const query = new URLSearchParams({
      broadcaster_id: this.config.TWITCH_BROADCASTER_ID!,
      moderator_id: this.config.TWITCH_BOT_USER_ID!,
    });
    const response = await this.helix(`/moderation/warnings?${query}`, {
      method: 'POST',
      body: JSON.stringify({ data: { user_id: input.userId, reason: input.reason } }),
    }, 'bot');
    if (!response.ok) return this.apiFailure('Twitch refused the warning.', response);
    return { ok: true, summary: 'Warned the Twitch chatter.' };
  }

  private async banRequest(userId: string, reason?: string, duration?: number): Promise<ToolExecutionResult> {
    const query = new URLSearchParams({
      broadcaster_id: this.config.TWITCH_BROADCASTER_ID!,
      moderator_id: this.config.TWITCH_BOT_USER_ID!,
    });
    const response = await this.helix(`/moderation/bans?${query}`, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          user_id: userId,
          ...(duration ? { duration } : {}),
          ...(reason ? { reason } : {}),
        },
      }),
    }, 'bot');
    if (!response.ok) return this.apiFailure(`Twitch refused the ${duration ? 'timeout' : 'ban'}.`, response);
    return { ok: true, summary: duration ? `Timed out the Twitch chatter for ${duration} seconds.` : 'Banned the Twitch chatter.' };
  }

  private async connect(state: ConnectionState, url: string, preserveSubscriptions: boolean): Promise<void> {
    if (this.stopped) return;
    state.preserveSubscriptionsOnWelcome = preserveSubscriptions;
    this.logger.info({ kind: state.kind, url }, 'Connecting to Twitch EventSub');
    const socket = new WebSocket(url);
    state.socket = socket;

    socket.on('open', () => {
      state.lastEventAt = Date.now();
      this.logger.info({ kind: state.kind }, 'Twitch EventSub socket opened');
    });

    socket.on('message', (raw) => {
      state.lastEventAt = Date.now();
      void this.handleEnvelope(state, socket, JSON.parse(raw.toString()) as TwitchEnvelope).catch((error) => {
        this.logger.error({ err: error, kind: state.kind }, 'Twitch EventSub message failed');
      });
    });

    socket.on('close', (code, reason) => {
      if (state.socket !== socket) return;
      state.ready = false;
      this.logger.warn({ kind: state.kind, code, reason: reason.toString() }, 'Twitch EventSub socket closed');
      if (!this.stopped) this.scheduleReconnect(state);
    });

    socket.on('error', (error) => {
      this.logger.error({ err: error, kind: state.kind }, 'Twitch EventSub socket error');
    });

    if (!state.healthTimer) {
      state.healthTimer = setInterval(() => {
        if (Date.now() - state.lastEventAt > 120_000 && state.socket?.readyState === WebSocket.OPEN) {
          this.logger.warn({ kind: state.kind }, 'Twitch EventSub became stale; reconnecting');
          state.socket.terminate();
        }
      }, 30_000);
    }
  }

  private scheduleReconnect(state: ConnectionState): void {
    if (state.reconnectTimer || this.stopped) return;
    const delay = Math.min(30_000, 1_000 * 2 ** state.reconnectAttempt++);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      void this.connect(state, DEFAULT_EVENTSUB_URL, false);
    }, delay);
  }

  private async handleEnvelope(state: ConnectionState, socket: WebSocket, envelope: TwitchEnvelope): Promise<void> {
    const fresh = await this.database.markExternalEventProcessed(`twitch-eventsub-${state.kind}`, envelope.metadata.message_id);
    if (!fresh) return;

    switch (envelope.metadata.message_type) {
      case 'session_welcome': {
        const sessionId = envelope.payload.session?.id;
        if (!sessionId) throw new Error('Twitch welcome message lacked a session ID.');
        if (!state.preserveSubscriptionsOnWelcome) {
          await this.createSubscriptions(state, sessionId);
        }
        state.preserveSubscriptionsOnWelcome = false;
        state.ready = true;
        state.reconnectAttempt = 0;
        this.logger.info({ kind: state.kind }, 'Cinder connected to Twitch EventSub');
        break;
      }
      case 'session_reconnect': {
        const reconnectUrl = envelope.payload.session?.reconnect_url;
        if (reconnectUrl) {
          state.ready = false;
          await this.connect(state, reconnectUrl, true);
          if (state.socket !== socket) socket.close(1000, 'Moved to Twitch reconnect URL');
        }
        break;
      }
      case 'notification':
        await this.handleNotification(envelope);
        break;
      case 'revocation':
        this.logger.error({ kind: state.kind, subscription: envelope.payload.subscription }, 'Twitch revoked an EventSub subscription');
        break;
      case 'session_keepalive':
        break;
      default:
        this.logger.debug({ kind: state.kind, type: envelope.metadata.message_type }, 'Ignored Twitch EventSub envelope');
    }
  }

  private async handleNotification(envelope: TwitchEnvelope): Promise<void> {
    const type = envelope.metadata.subscription_type ?? envelope.payload.subscription?.type ?? 'unknown';
    const event = envelope.payload.event ?? {};

    if (type === 'channel.chat.message') {
      await this.bufferChat(event, envelope.metadata.message_timestamp);
      return;
    }

    const actorId = String(event.user_id ?? event.from_broadcaster_user_id ?? 'twitch-system');
    const actorName = String(event.user_name ?? event.user_login ?? event.from_broadcaster_user_name ?? 'Twitch');
    const actor: ActorIdentity = {
      platform: 'twitch',
      platformUserId: actorId,
      displayName: actorName,
      username: String(event.user_login ?? actorName),
      roles: [],
      isBot: false,
      isBroadcaster: actorId === this.config.TWITCH_BROADCASTER_ID,
    };
    if (actorId !== 'twitch-system') actor.personId = await this.database.ensureIdentity(actor);

    await this.emitEvent({
      id: `twitch-event:${envelope.metadata.message_id}`,
      platform: 'twitch_event',
      occurredAt: envelope.metadata.message_timestamp,
      ...(this.config.TWITCH_BROADCASTER_ID ? { channelId: this.config.TWITCH_BROADCASTER_ID } : {}),
      channelName: 'Twitch stream',
      actor,
      text: describeTwitchNotification(type, event),
      mentions: [],
      attachments: [],
      metadata: { verified: true, subscriptionType: type, event },
    });
  }

  private async bufferChat(event: Record<string, unknown>, occurredAt: string): Promise<void> {
    const userId = String(event.chatter_user_id ?? 'unknown');
    const displayName = String(event.chatter_user_name ?? event.chatter_user_login ?? 'Unknown chatter');
    const actor: ActorIdentity = {
      platform: 'twitch',
      platformUserId: userId,
      displayName,
      username: String(event.chatter_user_login ?? displayName),
      roles: this.badgeRoles(event.badges),
      isBot: userId === this.config.TWITCH_BOT_USER_ID,
      isBroadcaster: userId === this.config.TWITCH_BROADCASTER_ID,
    };
    if (actor.isBot) return;
    actor.personId = await this.database.ensureIdentity(actor);

    const message = event.message as { text?: string } | undefined;
    const reply = event.reply as { parent_message_id?: string; parent_user_id?: string; parent_user_login?: string } | undefined;
    const entry: ChatEntry = {
      externalMessageId: String(event.message_id ?? randomUUID()),
      occurredAt,
      actor,
      text: String(message?.text ?? ''),
      ...(reply?.parent_message_id ? { replyParentMessageId: reply.parent_message_id } : {}),
      replyToCinder: reply?.parent_user_id === this.config.TWITCH_BOT_USER_ID
        || reply?.parent_user_login?.toLocaleLowerCase() === 'cinder_ai',
      badges: Array.isArray(event.badges) ? event.badges as ChatEntry['badges'] : [],
    };
    if (!entry.text) return;
    this.chatBuffer.push(entry);

    if (this.chatBuffer.length >= this.config.TWITCH_MAX_BATCH_MESSAGES) {
      await this.flushChat();
      return;
    }
    if (!this.chatTimer) {
      this.chatTimer = setTimeout(() => {
        this.chatTimer = undefined;
        void this.flushChat().catch((error) => this.logger.error({ err: error }, 'Twitch chat flush failed'));
      }, this.config.TWITCH_CHAT_BATCH_MS);
    }
  }

  private async flushChat(): Promise<void> {
    if (this.chatTimer) {
      clearTimeout(this.chatTimer);
      this.chatTimer = undefined;
    }
    if (this.chatBuffer.length === 0) return;
    const batch = this.chatBuffer.splice(0, this.config.TWITCH_MAX_BATCH_MESSAGES);
    const last = batch.at(-1)!;
    const directMention = batch.some((entry) => isDirectCinderAddress(entry.text));
    const replyToCinder = batch.some((entry) => entry.replyToCinder);
    const moderationCandidate = batch.some((entry) => isHighConfidenceConductProblem(entry.text));

    await this.emitEvent({
      id: `twitch-chat-batch:${batch[0]!.externalMessageId}:${batch.at(-1)!.externalMessageId}`,
      platform: 'twitch_chat',
      occurredAt: last.occurredAt,
      ...(this.config.TWITCH_BROADCASTER_ID ? { channelId: this.config.TWITCH_BROADCASTER_ID } : {}),
      channelName: 'Twitch chat',
      actor: last.actor,
      text: batch.map((entry) => `${entry.actor.displayName}: ${entry.text}`).join('\n'),
      mentions: [],
      attachments: [],
      metadata: {
        verified: true,
        directMention,
        replyToCinder,
        moderationCandidate,
        chatBatch: batch.map((entry) => ({
          messageId: entry.externalMessageId,
          occurredAt: entry.occurredAt,
          actor: entry.actor,
          text: entry.text,
          replyParentMessageId: entry.replyParentMessageId,
          replyToCinder: entry.replyToCinder,
          badges: entry.badges,
        })),
      },
    });
  }

  private async createSubscriptions(state: ConnectionState, sessionId: string): Promise<void> {
    const subscriptions = state.kind === 'chat'
      ? [
          {
            type: 'channel.chat.message',
            version: '1',
            condition: {
              broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID,
              user_id: this.config.TWITCH_BOT_USER_ID,
            },
            required: true,
          },
        ]
      : [
          { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID, moderator_user_id: this.config.TWITCH_BROADCASTER_ID }, required: false },
          { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID }, required: false },
          { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID }, required: false },
          { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID }, required: false },
          { type: 'channel.cheer', version: '1', condition: { broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID }, required: false },
          { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID }, required: false },
          { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: { broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID }, required: false },
          { type: 'stream.online', version: '1', condition: { broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID }, required: false },
          { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID }, required: false },
          { type: 'channel.update', version: '2', condition: { broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID }, required: false },
        ];

    for (const subscription of subscriptions) {
      const response = await this.helix('/eventsub/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          type: subscription.type,
          version: subscription.version,
          condition: subscription.condition,
          transport: { method: 'websocket', session_id: sessionId },
        }),
      }, state.tokenKind);
      if (!response.ok) {
        const detail = await response.text();
        if (subscription.required) throw new Error(`Required Twitch subscription ${subscription.type} failed: ${response.status} ${detail}`);
        this.logger.warn({ kind: state.kind, type: subscription.type, status: response.status, detail }, 'Optional Twitch subscription unavailable');
      }
    }
  }

  private async validateToken(kind: TokenKind, retry = true): Promise<TwitchValidation> {
    const token = this.tokens[kind].accessToken;
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${token}` },
    });
    if (response.status === 401 && retry) {
      await this.refreshAccessToken(kind);
      return this.validateToken(kind, false);
    }
    if (!response.ok) throw new Error(`Twitch ${kind} token validation failed: ${response.status} ${await response.text()}`);
    const validation = await response.json() as TwitchValidation;
    if (validation.client_id !== this.config.TWITCH_CLIENT_ID) {
      throw new Error(`Twitch ${kind} token belongs to a different client ID.`);
    }
    const expectedUser = kind === 'bot' ? this.config.TWITCH_BOT_USER_ID : this.config.TWITCH_BROADCASTER_ID;
    if (validation.user_id !== expectedUser) {
      throw new Error(`Twitch ${kind} token belongs to user ${validation.user_id}, not configured user ${expectedUser}.`);
    }
    const requiredScopes = kind === 'bot' ? BOT_REQUIRED_SCOPES : BROADCASTER_REQUIRED_SCOPES;
    const missing = requiredScopes.filter((scope) => !validation.scopes.includes(scope));
    if (missing.length > 0) {
      throw new Error(`Twitch ${kind} token is missing scopes: ${missing.join(', ')}`);
    }
    this.logger.info({ kind, login: validation.login, expiresIn: validation.expires_in }, 'Validated Twitch user token');
    return validation;
  }

  private async helix(path: string, init: RequestInit, tokenKind: TokenKind, retry = true): Promise<Response> {
    const response = await fetch(`https://api.twitch.tv/helix${path}`, {
      ...init,
      headers: {
        'Client-Id': this.config.TWITCH_CLIENT_ID!,
        Authorization: `Bearer ${this.tokens[tokenKind].accessToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    if (response.status === 401 && retry) {
      await this.refreshAccessToken(tokenKind);
      return this.helix(path, init, tokenKind, false);
    }
    return response;
  }

  private async refreshAccessToken(kind: TokenKind): Promise<void> {
    const query = new URLSearchParams({
      client_id: this.config.TWITCH_CLIENT_ID!,
      client_secret: this.config.TWITCH_CLIENT_SECRET!,
      grant_type: 'refresh_token',
      refresh_token: this.tokens[kind].refreshToken,
    });
    const response = await fetch(`https://id.twitch.tv/oauth2/token?${query}`, { method: 'POST' });
    if (!response.ok) throw new Error(`Twitch ${kind} token refresh failed: ${response.status} ${await response.text()}`);
    const data = await response.json() as { access_token: string; refresh_token?: string };
    this.tokens[kind].accessToken = data.access_token;
    if (data.refresh_token) this.tokens[kind].refreshToken = data.refresh_token;
    await this.database.setRuntimeState(`twitch_${kind}_tokens`, {
      accessToken: this.tokens[kind].accessToken,
      refreshToken: this.tokens[kind].refreshToken,
    });
    this.logger.info({ kind }, 'Refreshed Twitch access token');
  }

  private async apiFailure(prefix: string, response: Response): Promise<ToolExecutionResult> {
    const body = await response.text();
    return {
      ok: false,
      summary: `${prefix} HTTP ${response.status}: ${body.slice(0, 500)}`,
      errorCode: 'TWITCH_API_ERROR',
      retryable: response.status >= 500 || response.status === 429,
    };
  }

  private badgeRoles(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((badge) => typeof badge === 'object' && badge !== null ? String((badge as Record<string, unknown>).set_id ?? '') : '')
      .filter(Boolean);
  }
}
