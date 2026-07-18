export type Platform = 'discord_text' | 'discord_voice' | 'twitch_chat' | 'twitch_event' | 'windows';

export type AudienceScope =
  | 'senti_private'
  | 'moderator_private'
  | 'discord_public'
  | 'twitch_public'
  | 'cross_platform_safe'
  | 'voice_session'
  | 'temporary';

export interface ActorIdentity {
  platform: 'discord' | 'twitch' | 'windows' | 'system';
  platformUserId: string;
  personId?: string;
  displayName: string;
  username?: string;
  roles: string[];
  isBot: boolean;
  isBroadcaster?: boolean;
  isGuildOwner?: boolean;
}

export interface MessageReference {
  platform: 'discord' | 'twitch';
  serverId?: string;
  channelId: string;
  messageId: string;
  authorId?: string;
  authorName?: string;
  excerpt?: string;
}

export interface AttachmentReference {
  id: string;
  name: string;
  url: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface EventEnvelope {
  id: string;
  platform: Platform;
  occurredAt: string;
  serverId?: string;
  channelId?: string;
  channelName?: string;
  threadId?: string;
  voiceChannelId?: string;
  actor: ActorIdentity;
  text: string;
  replyTo?: MessageReference;
  mentions: Array<{ id: string; displayName: string; kind: 'user' | 'role' | 'channel' }>;
  attachments: AttachmentReference[];
  metadata: Record<string, unknown>;
}

export interface MemoryRecord {
  id: string;
  personId?: string;
  serverId?: string;
  scope: AudienceScope;
  kind: 'person' | 'episode' | 'self' | 'promise' | 'preference' | 'relationship' | 'configuration';
  content: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface PendingApproval {
  id: string;
  serverId: string;
  requestedByPlatformUserId: string;
  requestedByName: string;
  createdAt: string;
  expiresAt: string;
  description: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  originChannelId: string;
  approvalChannelId?: string;
}

export interface GuildConfiguration {
  serverId: string;
  moderatorRoleName: string;
  botAdminChannelId?: string;
  ownerDiscordUserId?: string;
  voiceJoinRoleName?: string;
  quietChannelIds: string[];
  memoryExcludedChannelIds: string[];
  twitchBroadcasterId?: string;
  twitchBotUserId?: string;
}

export interface Scene {
  current: EventEnvelope;
  recentEvents: EventEnvelope[];
  relevantMemories: MemoryRecord[];
  pendingApprovals: PendingApproval[];
  recentActions: ActionRecord[];
  guildConfiguration?: GuildConfiguration;
  activeVoiceParticipants: Array<{ userId: string; displayName: string; speaking: boolean }>;
  serverSnapshot?: Record<string, unknown>;
  platformState?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  currentEvent: EventEnvelope;
  scene: Scene;
  cinderTurnId: string;
}

export interface ToolExecutionResult {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
  errorCode?: string;
  retryable?: boolean;
}


export interface ActionRecord {
  id: string;
  turnId: string;
  eventId: string;
  serverId?: string;
  actorPlatformUserId?: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  result: ToolExecutionResult;
  createdAt: string;
}

export interface BridgeCommand {
  id: string;
  issuedAt: string;
  expiresAt: string;
  action:
    | 'play_song'
    | 'pause_media'
    | 'resume_media'
    | 'stop_media'
    | 'set_volume'
    | 'open_application'
    | 'obs_scene'
    | 'obs_stream_start'
    | 'obs_stream_stop';
  arguments: Record<string, unknown>;
}

export interface BridgeResult {
  commandId: string;
  completedAt: string;
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
}
