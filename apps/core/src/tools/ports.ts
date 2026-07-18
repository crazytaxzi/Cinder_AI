import type { EventEnvelope, ToolExecutionResult } from '@cinder/shared';

export interface DiscordToolPort {
  sendMessage(input: {
    serverId: string;
    channelReference: string;
    text: string;
    replyToMessageReference?: string;
  }): Promise<ToolExecutionResult>;
  addReaction(input: {
    serverId: string;
    channelReference: string;
    messageReference: string;
    emoji: string;
  }): Promise<ToolExecutionResult>;
  createChannel(input: {
    serverId: string;
    name: string;
    kind: 'text' | 'voice' | 'category' | 'forum';
    categoryReference?: string;
    topic?: string;
  }): Promise<ToolExecutionResult>;
  renameChannel(input: {
    serverId: string;
    channelReference: string;
    newName: string;
  }): Promise<ToolExecutionResult>;
  moveChannel(input: {
    serverId: string;
    channelReference: string;
    categoryReference?: string;
    position?: number;
  }): Promise<ToolExecutionResult>;
  deleteChannel(input: {
    serverId: string;
    channelReference: string;
    reason?: string;
  }): Promise<ToolExecutionResult>;
  setChannelReadOnly(input: {
    serverId: string;
    channelReference: string;
    readOnly: boolean;
    roleReference?: string;
  }): Promise<ToolExecutionResult>;
  deleteMessage(input: {
    serverId: string;
    channelReference: string;
    messageReference: string;
    reason?: string;
  }): Promise<ToolExecutionResult>;
  pinMessage(input: {
    serverId: string;
    channelReference: string;
    messageReference: string;
    pin: boolean;
  }): Promise<ToolExecutionResult>;
  timeoutMember(input: {
    serverId: string;
    userReference: string;
    minutes: number;
    reason?: string;
  }): Promise<ToolExecutionResult>;
  banMember(input: {
    serverId: string;
    userReference: string;
    reason?: string;
    deleteMessageSeconds?: number;
  }): Promise<ToolExecutionResult>;
  createRole(input: {
    serverId: string;
    name: string;
    color?: string;
    mentionable?: boolean;
    hoist?: boolean;
  }): Promise<ToolExecutionResult>;
  assignRole(input: {
    serverId: string;
    userReference: string;
    roleReference: string;
    assign: boolean;
  }): Promise<ToolExecutionResult>;
  joinVoice(input: {
    event: EventEnvelope;
    channelReference?: string;
  }): Promise<ToolExecutionResult>;
  leaveVoice(input: { serverId: string }): Promise<ToolExecutionResult>;
  fetchMessages(input: {
    serverId: string;
    channelReference: string;
    limit: number;
    beforeMessageReference?: string;
  }): Promise<EventEnvelope[]>;
  findMessagesByUser(input: {
    serverId: string;
    channelReference: string;
    userReference: string;
    scanLimit: number;
    resultLimit: number;
    query?: string;
  }): Promise<{ events: EventEnvelope[]; scanned: number; channelId: string; channelName: string; userId: string; userName: string }>;
  resolveChannelId(serverId: string, reference: string): Promise<string | undefined>;
  resolveRoleName(serverId: string, reference: string): Promise<string | undefined>;
  resolveUserIdentity(serverId: string, reference: string): Promise<{ id: string; displayName: string; username: string } | undefined>;
}

export interface TwitchToolPort {
  sendMessage(input: { text: string; replyParentMessageId?: string }): Promise<ToolExecutionResult>;
  deleteMessage(input: { messageId: string }): Promise<ToolExecutionResult>;
  timeoutUser(input: { userId: string; seconds: number; reason?: string }): Promise<ToolExecutionResult>;
  banUser(input: { userId: string; reason?: string }): Promise<ToolExecutionResult>;
  warnUser(input: { userId: string; reason: string }): Promise<ToolExecutionResult>;
}

export interface BridgeToolPort {
  sendCommand(input: {
    action: string;
    arguments: Record<string, unknown>;
  }): Promise<ToolExecutionResult>;
}
