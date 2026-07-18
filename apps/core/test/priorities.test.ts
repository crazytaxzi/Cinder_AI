import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@cinder/shared';
import { priorityForEvent } from '../src/cinder/priorities.js';

function event(platform: EventEnvelope['platform'], metadata: Record<string, unknown> = {}): EventEnvelope {
  return {
    id: 'x', platform, occurredAt: new Date().toISOString(),
    actor: { platform: 'system', platformUserId: 'x', displayName: 'x', roles: [], isBot: false },
    text: 'x', mentions: [], attachments: [], metadata,
  };
}

describe('priorityForEvent', () => {
  it('puts urgent moderation above ordinary conversation', () => {
    expect(priorityForEvent(event('discord_text', { urgentModeration: true })))
      .toBeGreaterThan(priorityForEvent(event('discord_text')));
  });

  it('puts voice above ambient Twitch', () => {
    expect(priorityForEvent(event('discord_voice'))).toBeGreaterThan(priorityForEvent(event('twitch_chat')));
  });
});
