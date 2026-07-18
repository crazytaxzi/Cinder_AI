import { describe, expect, it } from 'vitest';
import { describeTwitchNotification, twitchReplyParentMessageId } from '../src/adapters/twitch.js';

describe('Twitch event descriptions', () => {
  it('names the person who raided', () => {
    expect(describeTwitchNotification('channel.raid', {
      from_broadcaster_user_name: 'Pixel', viewers: 42,
    })).toBe('Pixel raided with 42 viewers.');
  });

  it('describes a channel point redemption by reward title', () => {
    expect(describeTwitchNotification('channel.channel_points_custom_reward_redemption.add', {
      user_name: 'Morgan', reward: { title: 'Hydrate' },
    })).toBe('Morgan redeemed Hydrate.');
  });

  it('does not pretend an unknown event is understood', () => {
    expect(describeTwitchNotification('unknown.event', { value: 1 }))
      .toContain('unknown.event');
  });
});

describe('Twitch reply targeting', () => {
  const baseEvent = {
    id: 'event',
    platform: 'twitch_chat',
    occurredAt: new Date().toISOString(),
    actor: {
      platform: 'twitch',
      platformUserId: 'viewer',
      displayName: 'Viewer',
      roles: [],
      isBot: false,
    },
    text: 'Hello Cinder',
    mentions: [],
    attachments: [],
  } as const;

  it('replies to one real received Twitch chat message', () => {
    expect(twitchReplyParentMessageId({
      ...baseEvent,
      metadata: {
        verified: true,
        chatBatch: [{ messageId: 'real-twitch-message-id' }],
      },
    })).toBe('real-twitch-message-id');
  });

  it('never replies to a synthetic deployment-verification message', () => {
    expect(twitchReplyParentMessageId({
      ...baseEvent,
      metadata: {
        verified: true,
        deploymentVerification: true,
        suppressReply: true,
        chatBatch: [{ messageId: 'synthetic-message-id' }],
      },
    })).toBeUndefined();
  });
});

