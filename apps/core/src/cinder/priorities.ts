import type { EventEnvelope } from '@cinder/shared';

export function priorityForEvent(event: EventEnvelope): number {
  if (event.metadata.urgentModeration === true) return 100;
  if (event.platform === 'discord_voice') return 80;
  if (event.replyTo?.authorId && event.metadata.replyToCinder === true) return 70;
  if (event.mentions.some((mention) => mention.id === event.metadata.cinderUserId)) return 65;
  if (event.platform === 'discord_text') return 50;
  if (event.platform === 'windows') return 45;
  if (event.platform === 'twitch_event') return 35;
  return 30;
}
